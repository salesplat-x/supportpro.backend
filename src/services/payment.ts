import { QueryFailedError } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Payment } from "../entities/Payment.js";
import { PaymentWebhookEvent } from "../entities/PaymentWebhookEvent.js";
import { Subscription } from "../entities/Subscription.js";
import { User } from "../entities/User.js";
import { Organization } from "../entities/Organization.js";
import { Plan } from "../entities/Plan.js";
import { Job } from "../entities/Job.js";
import { getPlanByKey, getSubscriptionPlanKeys, loadPricingCatalog, ngnToKobo } from "../config/pricingCatalog.js";
import env from "../config/env.js";
import { NotFoundError, ValidationError, ConflictError, AuthorizationError } from "../utils/errors";
import {
  BillingInterval,
  BillingStatus,
  FREE_PLAN_KEY,
  JobStatus,
  PaymentStatus,
  SubscriptionStatus,
} from "../types/enums.js";
import {
  initializePayment,
  verifyTransaction,
  generatePaymentObject,
  createCustomer,
  isDummyPaystack,
} from "../utils/integrations/paystack.js";
import { disable as disableSubscription } from "./subscription.js";
import { generateReference } from "../utils/crypto.js";
import EmailService from "../utils/integrations/email/emailService.js";

const paymentRepo = () => AppDataSource.getRepository(Payment);
const userRepo = () => AppDataSource.getRepository(User);
const eventRepo = () => AppDataSource.getRepository(PaymentWebhookEvent);
const subscriptionRepo = () => AppDataSource.getRepository(Subscription);
const organizationRepo = () => AppDataSource.getRepository(Organization);
const planRepo = () => AppDataSource.getRepository(Plan);
const jobRepo = () => AppDataSource.getRepository(Job);

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

const resolvePlanRow = async (planKey: string, interval: BillingInterval): Promise<Plan> => {
  const row = await planRepo().findOne({ where: { planKey, interval, isDeleted: false } });
  if (!row) throw new NotFoundError(`Plan ${planKey}/${interval} is not available`);
  if (!isDummyPaystack() && !row.paystackPlanCode) {
    throw new ValidationError(`Plan ${planKey}/${interval} is not connected to Paystack`);
  }
  return row;
};

/** Only the organization owner manages billing — purchasing/changing/cancelling the company's plan. */
const resolveOrganizationForBilling = async (user: User): Promise<Organization> => {
  if (!user.activeOrganizationId) {
    throw new ValidationError("Join or create a company before purchasing a plan");
  }
  const organization = await organizationRepo().findOne({ where: { id: user.activeOrganizationId } });
  if (!organization) {
    throw new NotFoundError("Organization not found");
  }
  if (organization.ownerId !== user.id) {
    throw new AuthorizationError("Only the organization owner can manage billing");
  }
  return organization;
};

const setOrganizationBilling = async (
  organizationId: string,
  patch: Partial<Pick<Organization, "billingPlan" | "billingInterval" | "billingStatus">>
): Promise<void> => {
  const organization = await organizationRepo().findOne({ where: { id: organizationId } });
  if (!organization) return;
  await organizationRepo().save({ ...organization, ...patch });
};

const sendPaymentReceipt = async (payment: Payment): Promise<void> => {
  const user = await userRepo().findOne({ where: { id: payment.userId } });
  if (!user) return;

  const catalog = loadPricingCatalog();
  const planRecord = payment.planId
    ? await planRepo().findOne({ where: { id: payment.planId } })
    : null;
  const metadataPlanKey = (payment.initialConfig as { metadata?: { planKey?: string } } | null)
    ?.metadata?.planKey;
  const planName = planRecord?.name ?? getPlanByKey(metadataPlanKey ?? "")?.name ?? "Your plan";
  const interval = payment.billingInterval === BillingInterval.Annually ? "Annually" : "Monthly";
  const paidAt = payment.paidAt ?? new Date();
  const origin = (env.website ?? "").replace(/\/$/, "");

  await new EmailService().sendPaymentConfirmation({
    email: user.email,
    firstName: user.firstName,
    planName,
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

/**
 * Completes a payment and applies its effect — either activating the specific job it was
 * for (Pay per Use, one-time per-job charge) or updating the organization's subscription
 * tier (every other plan). These are kept as two clearly separate branches rather than
 * one overloaded "apply billing" path, since they mean very different things.
 */
const fulfillPayment = async (payment: Payment, authorizationCode?: string): Promise<boolean> => {
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
    if (authorizationCode) {
      locked.finalConfig = {
        ...(locked.finalConfig ?? {}),
        authorization_code: authorizationCode,
      };
    }
    await manager.save(locked);

    const metadata = (locked.initialConfig as { metadata?: Record<string, string> } | null)
      ?.metadata;
    const jobId = metadata?.jobId;

    if (jobId) {
      await manager.update(Job, { id: jobId }, { status: JobStatus.Active });
    } else if (locked.organizationId) {
      const plan = locked.planId
        ? await manager.findOne(Plan, { where: { id: locked.planId } })
        : null;
      const organization = await manager.findOne(Organization, {
        where: { id: locked.organizationId },
        lock: { mode: "pessimistic_write" },
      });
      if (organization) {
        organization.billingPlan = plan?.planKey ?? "paid";
        organization.billingInterval = locked.billingInterval;
        organization.billingStatus = BillingStatus.Active;
        await manager.save(organization);
      }
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
    const newlyCompleted = await fulfillPayment(
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
    const newlyCompleted = await fulfillPayment(payment, authorizationCode);
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
    const subscriptionCode =
      (data.subscription as Record<string, string> | undefined)?.subscription_code ??
      (data.subscription_code as string | undefined);
    if (subscriptionCode) {
      const subscription = await subscriptionRepo().findOne({
        where: { paystackSubscriptionCode: subscriptionCode },
      });
      if (subscription) {
        await setOrganizationBilling(subscription.organizationId, {
          billingStatus: BillingStatus.PastDue,
        });
      }
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
        await setOrganizationBilling(subscription.organizationId, {
          billingPlan: FREE_PLAN_KEY,
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
    const planData = data.plan as Record<string, unknown> | string | undefined;
    const planCode =
      typeof planData === "string"
        ? planData
        : ((planData as Record<string, string> | undefined)?.plan_code ?? undefined);

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
        const plan = await planRepo().findOne({ where: { id: existing.planId } });
        await setOrganizationBilling(existing.organizationId, {
          billingPlan: plan?.planKey ?? "paid",
          billingStatus: BillingStatus.Active,
        });
      } else {
        const customerData = data.customer as Record<string, string> | undefined;
        const user = customerData?.email
          ? await userRepo().findOne({ where: { email: customerData.email } })
          : null;
        const plan = planCode ? await planRepo().findOne({ where: { paystackPlanCode: planCode } }) : null;

        if (user?.activeOrganizationId && plan) {
          const subscription = subscriptionRepo().create({
            userId: user.id,
            organizationId: user.activeOrganizationId,
            planId: plan.id,
            paystackSubscriptionCode: code,
            authorizationCode:
              (data.authorization as Record<string, string> | undefined)?.authorization_code ?? null,
            status: SubscriptionStatus.Active,
            startDate: new Date(),
            nextPaymentDate: data.next_payment_date ? new Date(data.next_payment_date as string) : null,
            cron_expression: (data.cron_expression as string) ?? null,
            email_token: (data.email_token as string) ?? null,
          });
          await subscriptionRepo().save(subscription);
          await setOrganizationBilling(user.activeOrganizationId, {
            billingPlan: plan.planKey,
            billingInterval: plan.interval,
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
  if (!payload.planKey || !getSubscriptionPlanKeys().includes(payload.planKey)) {
    throw new ValidationError("Unknown or non-subscription plan");
  }
  const planKey = payload.planKey;

  const organization = await resolveOrganizationForBilling(user);

  const interval =
    payload.interval === BillingInterval.Annually
      ? BillingInterval.Annually
      : BillingInterval.Monthly;
  const planRow = await resolvePlanRow(planKey, interval);

  // Tier changes auto-swap: the old subscription is disabled and the new one takes its
  // place immediately (product decision — the org loses the old plan's benefits until
  // the new payment completes, which the frontend warns about before this is called).
  const existingSubscription = await subscriptionRepo().findOne({
    where: { organizationId: organization.id, status: SubscriptionStatus.Active },
  });
  if (existingSubscription) {
    if (existingSubscription.planId === planRow.id) {
      throw new ConflictError("Your company is already on this plan");
    }
    await disableSubscription(existingSubscription.id);
  }

  const amountKobo = Math.round(planRow.paystackAmount);

  const reference = await generateReference(async (ref) => {
    const existing = await paymentRepo().findOne({ where: { reference: ref } });
    return !!existing;
  });

  await createCustomer({ email: user.email });

  const initialConfig = generatePaymentObject(amountKobo, user.email, {
    reference,
    planCode: isDummyPaystack() ? undefined : (planRow.paystackPlanCode ?? undefined),
    metadata: {
      userId: user.id,
      organizationId: organization.id,
      planKey,
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
      organizationId: organization.id,
      planId: planRow.id,
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

/**
 * Pay per Use has no Paystack subscription plan — every job posting is a fresh one-time
 * charge, initiated from the job-posting flow rather than the pricing page. Any recruiter
 * at the org can trigger this (unlike initiateTransaction, this isn't a billing-management
 * action — posting jobs is normal recruiter work).
 */
export const initiateJobPayment = async (
  user: User,
  jobId: string
): Promise<{ link: string; reference: string; mode: string }> => {
  const job = await jobRepo().findOne({ where: { id: jobId } });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  if (!job.organizationId) {
    throw new ValidationError("Job has no organization");
  }
  if (job.status === JobStatus.Active) {
    throw new ConflictError("This job is already active");
  }
  if (user.activeOrganizationId !== job.organizationId) {
    throw new AuthorizationError("You are not authorized to pay for this job");
  }

  const organization = await organizationRepo().findOne({ where: { id: job.organizationId } });
  if (!organization) {
    throw new NotFoundError("Organization not found");
  }
  if (organization.billingPlan !== "pay_per_use") {
    throw new ValidationError("This job's organization is not on the Pay per Use plan");
  }

  const plan = getPlanByKey("pay_per_use");
  if (!plan) {
    throw new NotFoundError("Pay per Use plan not found in catalogue");
  }
  const amountKobo = ngnToKobo(plan.monthlyAmountNgn);

  const reference = await generateReference(async (ref) => {
    const existing = await paymentRepo().findOne({ where: { reference: ref } });
    return !!existing;
  });

  await createCustomer({ email: user.email });

  const initialConfig = generatePaymentObject(amountKobo, user.email, {
    reference,
    metadata: {
      userId: user.id,
      organizationId: organization.id,
      jobId: job.id,
      planKey: "pay_per_use",
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
      billingInterval: null,
      userId: user.id,
      organizationId: organization.id,
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
