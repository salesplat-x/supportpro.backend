import { AppDataSource } from "../database/dataSource.js";
import { Payment } from "../entities/Payment.js";
import { Plan } from "../entities/Plan.js";
import { Subscription } from "../entities/Subscription.js";
import { User } from "../entities/User.js";
import { NotFoundError, ValidationError, ConflictError } from "../utils/errors/index.js";
import { PaymentStatus, SubscriptionStatus } from "../types/enums.js";
import {
  initializePayment,
  verifyTransaction,
  generatePaymentObject,
  createCustomer,
  PaymentVerificationStatus,
  IPaystackConfig,
} from "../utils/integrations/paystack.js";
import { createSubscription, hasRunningSubscription } from "./subscription.js";
import { generateReference } from "../utils/crypto.js";

function paymentRepo() {
  return AppDataSource.getRepository(Payment);
}

function planRepo() {
  return AppDataSource.getRepository(Plan);
}

function subscriptionRepo() {
  return AppDataSource.getRepository(Subscription);
}

function userRepo() {
  return AppDataSource.getRepository(User);
}

export const paymentRecords = async (userId: string): Promise<Payment[]> => {
  return paymentRepo().find({
    where: { userId },
    relations: { plan: true },
    order: { createdAt: "DESC" },
  });
};

export const verify = async (payload: { reference: string }): Promise<void> => {
  const payment = await paymentRepo().findOne({
    where: { paystackRef: payload.reference },
    relations: { plan: true },
  });
  if (!payment) {
    throw new NotFoundError("Payment not found for reference");
  }
  if (payment.status === PaymentStatus.Completed) {
    throw new ConflictError("Payment already verified");
  }

  const user = await userRepo().findOne({ where: { id: payment.userId } });
  if (!user) {
    throw new NotFoundError("User not found");
  }

  const response = await verifyTransaction(payment.paystackRef!);

  if (!response || !response.status) {
    throw new ValidationError("Unable to verify payment");
  }

  if (
    response.data.status === "success" &&
    response.data.currency === payment.currency &&
    response.data.amount >= payment.amount
  ) {
    await paymentRepo().save({
      ...payment,
      status: PaymentStatus.Completed,
      finalConfig: response as unknown as Record<string, unknown>,
      paidAt: new Date(),
      history: [
        ...(payment.history ?? []),
        {
          description: "Payment made",
          author: payment.userId,
          date: new Date(),
        },
      ],
    });

    // Create subscription if payment was for a plan
    if (response.data.plan && payment.planId) {
      await createSubscription(
        user,
        payment.planId,
        response.data.authorization.authorization_code
      );
    }
    return;
  }

  if (response.data.status === PaymentVerificationStatus.Failed) {
    await paymentRepo().save({
      ...payment,
      status: PaymentStatus.Failed,
      finalConfig: response as unknown as Record<string, unknown>,
      history: [
        ...(payment.history ?? []),
        {
          description: "Payment failed!",
          author: payment.userId,
          date: new Date(),
        },
      ],
    });
    throw new ValidationError("Payment failed");
  }

  throw new ValidationError("Payment failed");
};

export const paystackWebhook = async (payload: {
  event: string;
  data: Record<string, unknown>;
}): Promise<void> => {
  const { event, data } = payload;

  if (event === "charge.success" && data.status === "success") {
    const payment = await paymentRepo().findOne({
      where: [{ paystackRef: data.reference as string }, { reference: data.reference as string }],
    });
    if (!payment) return; // Silently ignore — not our payment

    if (payment.status === PaymentStatus.Completed) return;

    const user = await userRepo().findOne({ where: { id: payment.userId } });
    if (!user) return;

    await paymentRepo().save({
      ...payment,
      status: PaymentStatus.Completed,
      finalConfig: data,
      paidAt: new Date(),
      history: [
        ...(payment.history ?? []),
        {
          description: "Payment made",
          author: payment.userId,
          date: new Date(),
        },
      ],
    });

    if (payment.planId) {
      const authorizationCode =
        (data.authorization as Record<string, string> | undefined)?.authorization_code ?? "";
      // Let errors propagate — a failed subscription creation should surface
      // as a 500 so it can be retried via Paystack's webhook retry mechanism.
      await createSubscription(user, payment.planId, authorizationCode);
    }
    return;
  }

  if (event === "subscription.create" && data.status === "active") {
    const existingSubscription = await subscriptionRepo().findOne({
      where: { paystackSubscriptionCode: data.subscription_code as string },
    });

    if (existingSubscription) {
      await subscriptionRepo().save({
        ...existingSubscription,
        status: data.status as SubscriptionStatus,
        startDate: new Date(data.start as string),
        nextPaymentDate: data.next_payment_date ? new Date(data.next_payment_date as string) : null,
        cron_expression: (data.cron_expression as string) ?? null,
        email_token: (data.email_token as string) ?? null,
        history: [
          ...(existingSubscription.history ?? []),
          {
            description: "Subscription activated",
            author: existingSubscription.userId,
            date: new Date(),
          },
        ],
      });
    } else {
      const planData = data.plan as Record<string, string>;
      const plan = await planRepo().findOne({ where: { paystackPlanCode: planData.plan_code } });
      if (!plan) return;

      const customerData = data.customer as Record<string, string>;
      const user = await userRepo().findOne({ where: { email: customerData.email } });
      if (!user) return;

      const authData = data.authorization as Record<string, string> | undefined;
      await subscriptionRepo().save(
        subscriptionRepo().create({
          userId: user.id,
          planId: plan.id,
          paystackSubscriptionCode: data.subscription_code as string,
          authorizationCode: authData?.authorization_code ?? null,
          status: data.status as SubscriptionStatus,
          startDate: new Date(data.start as string),
          nextPaymentDate: data.next_payment_date
            ? new Date(data.next_payment_date as string)
            : null,
          cron_expression: (data.cron_expression as string) ?? null,
          email_token: (data.email_token as string) ?? null,
        })
      );
    }
    return;
  }

  if (event === "subscription.disable") {
    const subscription = await subscriptionRepo().findOne({
      where: { paystackSubscriptionCode: data.subscription_code as string },
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
    }
    return;
  }

  if (event === "subscription.enable") {
    const subscription = await subscriptionRepo().findOne({
      where: { paystackSubscriptionCode: data.subscription_code as string },
    });
    if (subscription) {
      await subscriptionRepo().save({
        ...subscription,
        status: SubscriptionStatus.Active,
        history: [
          ...(subscription.history ?? []),
          {
            description: "Subscription enabled",
            author: subscription.userId,
            date: new Date(),
          },
        ],
      });
    }
    return;
  }
};

export const initiateTransaction = async (
  user: User,
  payload: { amount?: number; planId?: string }
): Promise<{ link: string }> => {
  let plan: Plan | null = null;
  let initialConfig: IPaystackConfig;

  const reference = await generateReference(async (ref) => {
    const existing = await paymentRepo().findOne({ where: { reference: ref } });
    return !!existing;
  });

  if (payload.planId) {
    plan = await planRepo().findOne({ where: { id: payload.planId, isDeleted: false } });
    if (!plan) {
      throw new NotFoundError("Plan not found");
    }

    await createCustomer({ email: user.email });

    const alreadySubscribed = await hasRunningSubscription(user, plan.id);
    if (alreadySubscribed) {
      throw new ConflictError("You already have an active subscription for this plan");
    }

    const amount = plan.paystackAmount;
    initialConfig = generatePaymentObject(amount, user.email, plan.paystackPlanCode ?? undefined);
  } else {
    if (!payload.amount) {
      throw new ValidationError("Amount is required");
    }
    initialConfig = generatePaymentObject(payload.amount, user.email);
  }

  const paymentResponse = await initializePayment(initialConfig);

  await paymentRepo().save(
    paymentRepo().create({
      amount: initialConfig.amount / 100,
      currency: initialConfig.currency,
      paymentLink: paymentResponse.data.authorization_url,
      reference,
      paystackRef: paymentResponse.data.reference,
      userId: user.id,
      planId: plan ? plan.id : null,
      status: PaymentStatus.Pending,
    })
  );

  return { link: paymentResponse.data.authorization_url };
};
