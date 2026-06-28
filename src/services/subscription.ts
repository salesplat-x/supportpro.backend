import { AppDataSource } from "../database/dataSource.js";
import { Subscription } from "../entities/Subscription.js";
import { Plan } from "../entities/Plan.js";
import { User } from "../entities/User.js";
import { NotFoundError, ConflictError, ValidationError } from "../utils/errors/index.js";
import { SubscriptionStatus } from "../types/enums.js";
import {
  createSubscription as paystackCreateSubscription,
  enableSubscription as paystackEnableSubscription,
  disableSubscription as paystackDisableSubscription,
  listSubscriptions,
  ISubConfig,
} from "../utils/integrations/paystack.js";

function subscriptionRepo() {
  return AppDataSource.getRepository(Subscription);
}

function planRepo() {
  return AppDataSource.getRepository(Plan);
}

export const fetchAll = async (): Promise<Subscription[]> => {
  return subscriptionRepo().find({ relations: { user: true, plan: true } });
};

export const fetchOne = async (id: string): Promise<Subscription> => {
  const sub = await subscriptionRepo().findOne({
    where: { id },
    relations: { user: true, plan: true },
  });
  if (!sub) {
    throw new NotFoundError("Subscription not found");
  }
  return sub;
};

export const fetchByMatch = async (payload: {
  userId?: string;
  planId?: string;
}): Promise<Subscription> => {
  const qb = subscriptionRepo()
    .createQueryBuilder("sub")
    .leftJoinAndSelect("sub.user", "user")
    .leftJoinAndSelect("sub.plan", "plan");

  if (payload.userId) {
    qb.orWhere("sub.user_id = :userId", { userId: payload.userId });
  }
  if (payload.planId) {
    qb.orWhere("sub.plan_id = :planId", { planId: payload.planId });
  }

  const sub = await qb.getOne();
  if (!sub) {
    throw new NotFoundError("Subscription not found");
  }
  return sub;
};

export const disable = async (id: string): Promise<Subscription> => {
  const subscription = await subscriptionRepo().findOne({ where: { id } });
  if (!subscription) {
    throw new NotFoundError("Subscription not found");
  }

  if (subscription.status === SubscriptionStatus.Cancelled) {
    return subscription;
  }

  const response = await paystackDisableSubscription({
    code: subscription.paystackSubscriptionCode,
    token: subscription.email_token ?? "",
  });
  if (!response.status) {
    throw new ValidationError("Paystack update failed");
  }

  return subscriptionRepo().save({ ...subscription, status: SubscriptionStatus.Cancelled });
};

export const enable = async (id: string): Promise<Subscription> => {
  const subscription = await subscriptionRepo().findOne({ where: { id } });
  if (!subscription) {
    throw new NotFoundError("Subscription not found");
  }

  if (subscription.status === SubscriptionStatus.Active) {
    return subscription;
  }

  const response = await paystackEnableSubscription({
    code: subscription.paystackSubscriptionCode,
    token: subscription.email_token ?? "",
  });
  if (!response.status) {
    throw new ValidationError("Paystack update failed");
  }

  return subscriptionRepo().save({ ...subscription, status: SubscriptionStatus.Active });
};

export const createSubscription = async (
  user: User,
  planId: string,
  authorizationCode: string,
  startDate?: Date
): Promise<Subscription> => {
  const plan = await planRepo().findOne({ where: { id: planId, isDeleted: false } });
  if (!plan) {
    throw new NotFoundError("Plan not found");
  }

  try {
    const subConfig: ISubConfig = {
      customer: user.email,
      plan: plan.paystackPlanCode!,
      authorization: authorizationCode,
      start_date: startDate,
    };

    const response = await paystackCreateSubscription(subConfig);

    if (!response.status) {
      throw new ValidationError("Failed to create Paystack subscription");
    }

    const subscription = subscriptionRepo().create({
      userId: user.id,
      planId: plan.id,
      paystackSubscriptionCode: response.data.subscription_code,
      authorizationCode: response.data.authorization.authorization_code,
      status: response.data.status as SubscriptionStatus,
      startDate: new Date(Date.now()),
      nextPaymentDate: response.data.next_payment_date ?? null,
      cron_expression: response.data.cron_expression ?? null,
      email_token: response.data.email_token,
    });

    return subscriptionRepo().save(subscription);
  } catch (error: unknown) {
    const axiosError = error as { response?: { data?: { code?: string } }; message?: string };
    if (axiosError.response?.data?.code === "duplicate_subscription") {
      try {
        const paystackSubs = await listSubscriptions(user.email);

        if (paystackSubs.status && paystackSubs.data && paystackSubs.data.length > 0) {
          const existingPaystackSub = paystackSubs.data.find(
            (sub: Record<string, unknown> & { customer: { email: string }; plan: { plan_code: string }; status: string }) =>
              sub.customer.email === user.email &&
              sub.plan.plan_code === plan.paystackPlanCode &&
              (sub.status === "active" || sub.status === "non-renewing")
          );

          if (existingPaystackSub) {
            const subscription = subscriptionRepo().create({
              userId: user.id,
              planId: plan.id,
              paystackSubscriptionCode: existingPaystackSub.subscription_code as string,
              authorizationCode: (existingPaystackSub.authorization as { authorization_code?: string })?.authorization_code ?? null,
              status: existingPaystackSub.status as SubscriptionStatus,
              startDate: new Date(existingPaystackSub.start as string),
              nextPaymentDate: (existingPaystackSub.next_payment_date as Date) ?? null,
              cron_expression: (existingPaystackSub.cron_expression as string) ?? null,
              email_token: (existingPaystackSub.email_token as string) ?? null,
            });

            return subscriptionRepo().save(subscription);
          }
        }

        throw new NotFoundError("No existing subscription found on Paystack");
      } catch (fetchError) {
        throw new ValidationError("Error fetching existing subscription from Paystack");
      }
    }

    throw new ValidationError(
      `Error creating subscription: ${axiosError.message ?? "Unknown error"}`
    );
  }
};

export const hasRunningSubscription = async (user: User, planId: string): Promise<boolean> => {
  const localSub = await subscriptionRepo().findOne({
    where: { userId: user.id, planId, status: SubscriptionStatus.Active },
  });
  if (localSub) return true;

  const plan = await planRepo().findOne({ where: { id: planId, isDeleted: false } });
  if (!plan) return false;

  const paystackSubs = await listSubscriptions(user.email);
  if (paystackSubs.status && paystackSubs.data) {
    const alreadyActive = paystackSubs.data.find(
      (sub: { customer: { email: string }; plan: { plan_code: string }; status: string }) =>
        sub.customer.email === user.email &&
        sub.plan.plan_code === plan.paystackPlanCode &&
        (sub.status === "active" || sub.status === "non-renewing")
    );
    if (alreadyActive) return true;
  }
  return false;
};

export const subscribe = async (
  user: User,
  payload: { planId: string }
): Promise<Subscription> => {
  const alreadySubscribed = await hasRunningSubscription(user, payload.planId);
  if (alreadySubscribed) {
    throw new ConflictError("User already on a plan, deactivate or unsubscribe first");
  }

  const plan = await planRepo().findOne({ where: { id: payload.planId } });
  if (!plan) {
    throw new NotFoundError("Plan not found");
  }

  const response = await paystackCreateSubscription({
    customer: user.email,
    plan: plan.paystackPlanCode!,
  });

  const subscription = subscriptionRepo().create({
    userId: user.id,
    planId: payload.planId,
    paystackSubscriptionCode: response.data.subscription_code,
    authorizationCode: response.data.authorization.authorization_code,
    status: response.data.status as SubscriptionStatus,
    startDate: new Date(),
    nextPaymentDate: response.data.next_payment_date ?? null,
    cron_expression: response.data.cron_expression ?? null,
    email_token: response.data.email_token,
  });

  return subscriptionRepo().save(subscription);
};
