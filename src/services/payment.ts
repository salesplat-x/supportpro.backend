import { QueryFailedError } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Payment } from "../entities/Payment.js";
import { PaymentWebhookEvent } from "../entities/PaymentWebhookEvent.js";
import { Subscription } from "../entities/Subscription.js";
import { User } from "../entities/User.js";
import {
  amountKoboForInterval,
  getPaidPlan,
  loadPricingCatalog,
} from "../config/pricingCatalog.js";
import env from "../config/env.js";
import { NotFoundError, ValidationError, ConflictError, AuthorizationError } from "../utils/errors";
import {
  BillingInterval,
  BillingPlan,
  BillingStatus,
  PaymentStatus,
  SubscriptionStatus,
} from "../types/enums.js";
import {
  initializePayment,
  verifyTransaction,
  generatePaymentObject,
  createCustomer,
  isDummyPaystack,
  paystackPlanCodeForInterval,
} from "../utils/integrations/paystack.js";
import { generateReference } from "../utils/crypto.js";
import EmailService from "../utils/integrations/email/emailService.js";

const paymentRepo = () => AppDataSource.getRepository(Payment);
const userRepo = () => AppDataSource.getRepository(User);
const eventRepo = () => AppDataSource.getRepository(PaymentWebhookEvent);
const subscriptionRepo = () => AppDataSource.getRepository(Subscription);

export const paymentRecords = async (userId: string): Promise<Payment[]> => {
  return paymentRepo().find({
    where: { userId },
    relations: { plan: true },
    order: { createdAt: "DESC" },
  });
};

const appendHistory = (
  payment: Payment,
  description: string
): Array<{ description: string; author: string; date: Date }> => [
  ...(payment.history ?? []),
  { description, author: payment.userId, date: new Date() },
];

const formatMoney = (amount: number, symbol: string): string => {
  const formatted = new Intl.NumberFormat("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return `${symbol}${formatted}`;
};

const sendPaymentReceipt = async (payment: Payment): Promise<void> => {
  const user = await userRepo().findOne({ where: { id: payment.userId } });
  if (!user) return;

  const catalog = loadPricingCatalog();
  const plan = getPaidPlan();
  const interval = payment.billingInterval === BillingInterval.Annually ? "Annually" : "Monthly";
  const paidAt = payment.paidAt ?? new Date();
  const origin = (env.website ?? "").replace(/\/$/, "");

  await new EmailService().sendPaymentConfirmation({
    email: user.email,
    firstName: user.firstName,
    planName: plan.name,
    interval,
    amount: formatMoney(payment.amount, catalog.currencySymbol),
    currency: payment.currency,
    reference: payment.paystackRef ?? payment.reference ?? "",
    paidAt: paidAt.toLocaleString("en-NG", {
      dateStyle: "medium",
      timeStyle: "short",
    }),
    billingStatus: "Active",
    manageUrl: `${origin}/recruiterDashboard/plan`,
  });
};

const fulfillPaid = async (payment: Payment, authorizationCode?: string): Promise<boolean> => {
  let newlyCompleted = false;
  await AppDataSource.manager.transaction(async (manager) => {
    const locked = await manager.findOne(Payment, {
      where: { id: payment.id },
      lock: { mode: "pessimistic_write" },
    });
    if (!locked) return;
    if (locked.status === PaymentStatus.Completed) return;

    locked.status = PaymentStatus.Completed;
    locked.paidAt = new Date();
    locked.history = appendHistory(locked, "Payment completed");
    await manager.save(locked);

    const user = await manager.findOne(User, {
      where: { id: locked.userId },
      lock: { mode: "pessimistic_write" },
    });
    if (!user) return;

    user.billingPlan = BillingPlan.Paid;
    user.billingInterval = locked.billingInterval;
    user.billingStatus = BillingStatus.Active;
    await manager.save(user);

    if (authorizationCode) {
      locked.finalConfig = {
        ...(locked.finalConfig ?? {}),
        authorization_code: authorizationCode,
      };
      await manager.save(locked);
    }

    newlyCompleted = true;
  });
  return newlyCompleted;
};

const markFailed = async (payment: Payment, reason: string): Promise<void> => {
  await AppDataSource.manager.transaction(async (manager) => {
    const locked = await manager.findOne(Payment, {
      where: { id: payment.id },
      lock: { mode: "pessimistic_write" },
    });
    if (!locked) return;
    if (locked.status === PaymentStatus.Completed) return;
    locked.status = PaymentStatus.Failed;
    locked.history = appendHistory(locked, reason);
    await manager.save(locked);
  });
};

export const verify = async (user: User, payload: { reference: string }): Promise<void> => {
  const payment = await paymentRepo().findOne({
    where: [{ paystackRef: payload.reference }, { reference: payload.reference }],
  });
  if (!payment) {
    throw new NotFoundError("Payment not found for reference");
  }
  if (payment.userId !== user.id) {
    throw new AuthorizationError("You cannot verify this payment");
  }
  if (payment.status === PaymentStatus.Completed) {
    return;
  }

  const response = await verifyTransaction(payment.paystackRef ?? payment.reference ?? "");
  if (!response?.status) {
    throw new ValidationError("Unable to verify payment");
  }

  const chargedKobo = response.data.amount;
  const currency = response.data.currency;
  const status = response.data.status;

  if (status === "success") {
    if (!isDummyPaystack()) {
      if (currency !== payment.currency) {
        throw new ValidationError("Payment currency does not match");
      }
      if (chargedKobo !== payment.amountKobo) {
        throw new ValidationError("Payment amount does not match");
      }
    }
    const newlyCompleted = await fulfillPaid(
      payment,
      response.data.authorization?.authorization_code
    );
    if (newlyCompleted) {
      const completed = await paymentRepo().findOne({ where: { id: payment.id } });
      if (completed) await sendPaymentReceipt(completed);
    }
    return;
  }

  if (status === "failed" || status === "abandoned") {
    await markFailed(payment, "Payment failed");
    throw new ValidationError("Payment failed");
  }

  throw new ValidationError("Payment is not yet complete");
};

const recordWebhookEvent = async (
  eventKey: string,
  event: string,
  reference: string | null
): Promise<boolean> => {
  try {
    await eventRepo().save(eventRepo().create({ eventKey, event, reference }));
    return true;
  } catch (error) {
    if (error instanceof QueryFailedError) {
      const driver = error.driverError as { code?: string };
      if (driver.code === "23505") return false;
    }
    throw error;
  }
};

const findPaymentByReference = async (reference: string): Promise<Payment | null> => {
  return paymentRepo().findOne({
    where: [{ paystackRef: reference }, { reference }],
  });
};

const setUserBilling = async (
  userId: string,
  patch: Partial<Pick<User, "billingPlan" | "billingInterval" | "billingStatus">>
): Promise<void> => {
  const user = await userRepo().findOne({ where: { id: userId } });
  if (!user) return;
  await userRepo().save({ ...user, ...patch });
};

export const paystackWebhook = async (payload: {
  event: string;
  data: Record<string, unknown>;
}): Promise<void> => {
  const { event, data } = payload;
  const reference = (data.reference as string | undefined) ?? null;
  const paystackId = data.id != null ? String(data.id) : "";
  const eventKey = `${event}:${reference ?? (data.subscription_code as string | undefined) ?? "none"}:${paystackId}`;

  const alreadyProcessed = await eventRepo().findOne({ where: { eventKey } });
  if (alreadyProcessed) return;

  const finish = async () => {
    await recordWebhookEvent(eventKey, event, reference);
  };

  if (event === "charge.success" && data.status === "success") {
    if (!reference) {
      await finish();
      return;
    }
    const payment = await findPaymentByReference(reference);
    if (!payment) {
      await finish();
      return;
    }

    if (!isDummyPaystack()) {
      const chargedKobo = Number(data.amount);
      const currency = data.currency as string | undefined;
      if (currency && currency !== payment.currency) {
        await finish();
        return;
      }
      if (Number.isFinite(chargedKobo) && chargedKobo !== payment.amountKobo) {
        await finish();
        return;
      }
    }

    const authorizationCode =
      (data.authorization as Record<string, string> | undefined)?.authorization_code ?? undefined;
    const newlyCompleted = await fulfillPaid(payment, authorizationCode);
    if (newlyCompleted) {
      const completed = await paymentRepo().findOne({ where: { id: payment.id } });
      if (completed) await sendPaymentReceipt(completed);
    }
    await finish();
    return;
  }

  if (event === "charge.failed" || event === "charge.abandoned") {
    if (reference) {
      const payment = await findPaymentByReference(reference);
      if (payment) await markFailed(payment, `Paystack ${event}`);
    }
    await finish();
    return;
  }

  if (event === "invoice.payment_failed") {
    const customer = data.customer as Record<string, string> | undefined;
    const email = customer?.email;
    if (email) {
      const user = await userRepo().findOne({ where: { email } });
      if (user) await setUserBilling(user.id, { billingStatus: BillingStatus.PastDue });
    }
    await finish();
    return;
  }

  if (event === "subscription.disable") {
    const code = data.subscription_code as string | undefined;
    if (code) {
      const subscription = await subscriptionRepo().findOne({
        where: { paystackSubscriptionCode: code },
      });
      if (subscription) {
        await subscriptionRepo().save({
          ...subscription,
          status: SubscriptionStatus.Cancelled,
          history: [
            ...(subscription.history ?? []),
            {
              description: "Subscription disabled",
              author: subscription.userId,
              date: new Date(),
            },
          ],
        });
        await setUserBilling(subscription.userId, {
          billingPlan: BillingPlan.Free,
          billingInterval: null,
          billingStatus: BillingStatus.Cancelled,
        });
      }
    }
    await finish();
    return;
  }

  if (event === "subscription.enable" || event === "subscription.create") {
    const code = data.subscription_code as string | undefined;
    if (code) {
      const existing = await subscriptionRepo().findOne({
        where: { paystackSubscriptionCode: code },
      });
      if (existing) {
        await subscriptionRepo().save({
          ...existing,
          status: SubscriptionStatus.Active,
          email_token: (data.email_token as string) ?? existing.email_token,
          nextPaymentDate: data.next_payment_date
            ? new Date(data.next_payment_date as string)
            : existing.nextPaymentDate,
        });
        await setUserBilling(existing.userId, {
          billingPlan: BillingPlan.Paid,
          billingStatus: BillingStatus.Active,
        });
      } else {
        const customerData = data.customer as Record<string, string> | undefined;
        const user = customerData?.email
          ? await userRepo().findOne({ where: { email: customerData.email } })
          : null;
        if (user) {
          await setUserBilling(user.id, {
            billingPlan: BillingPlan.Paid,
            billingStatus: BillingStatus.Active,
          });
        }
      }
    }
    await finish();
    return;
  }

  await finish();
};

export const initiateTransaction = async (
  user: User,
  payload: { planKey?: string; interval?: BillingInterval }
): Promise<{ link: string; reference: string; mode: string }> => {
  if (payload.planKey !== "paid") {
    throw new ValidationError("Only the paid plan can be purchased");
  }
  if (user.billingPlan === BillingPlan.Paid && user.billingStatus === BillingStatus.Active) {
    throw new ConflictError("You already have an active paid plan");
  }

  const interval =
    payload.interval === BillingInterval.Annually
      ? BillingInterval.Annually
      : BillingInterval.Monthly;
  const amountKobo = amountKoboForInterval(interval);

  const reference = await generateReference(async (ref) => {
    const existing = await paymentRepo().findOne({ where: { reference: ref } });
    return !!existing;
  });

  await createCustomer({ email: user.email });

  const initialConfig = generatePaymentObject(amountKobo, user.email, {
    reference,
    planCode: isDummyPaystack() ? undefined : paystackPlanCodeForInterval(interval),
    metadata: {
      userId: user.id,
      planKey: "paid",
      interval,
    },
  });

  const paymentResponse = await initializePayment(initialConfig);
  const paystackRef = paymentResponse.data.reference;

  await paymentRepo().save(
    paymentRepo().create({
      amount: amountKobo / 100,
      amountKobo,
      currency: initialConfig.currency,
      paymentLink: paymentResponse.data.authorization_url,
      reference,
      paystackRef,
      billingInterval: interval,
      userId: user.id,
      planId: null,
      status: PaymentStatus.Pending,
      initialConfig: initialConfig as unknown as Record<string, unknown>,
    })
  );

  return {
    link: paymentResponse.data.authorization_url,
    reference: paystackRef,
    mode: isDummyPaystack() ? "dummy" : "paystack",
  };
};
