import * as repository from "../../repository/v1/subscription";
import * as planRepository from "../../repository/v1/plan";
import * as paystackService from "../../services/v1/paystack";
import { makeResponse } from "../../helpers/response";
import { ISubFindConfig, SubscriptionStatus } from "../../typings/subscription";
import { AtLeastOne } from "../../helpers/utils";
import { IUser } from "../../typings/user";

export const fetch = async () => {
  const subs = await repository.findAllSubscription();

  return makeResponse(true, "Subscriptions fetched successfully", { subs });
};

export const fetchOne = async (id: string) => {
  const sub = await repository.findSubscriptionById(id);
  if (!sub) {
    return makeResponse(false, `Subscription not found`, {}, 404);
  }

  return makeResponse(true, "Subscription fetched successfully", {
    sub,
  });
};

export const fetchByMatch = async (payload: AtLeastOne<ISubFindConfig>) => {
  const sub = await repository.findSubscriptionByMatch({
    $or: [{ user: payload.user }, { plan: payload.plan }],
  });

  if (!sub) {
    return makeResponse(false, `Subscription not found`, {}, 404);
  }
  return makeResponse(true, "Subscription fetched successfully", {
    sub,
  });
};

export const disable = async (id: string) => {
  const subscription = await repository.findSubscriptionById(id);
  if (!subscription) {
    return makeResponse(false, `Subscription not found`, {}, 404);
  }

  if (subscription.status === SubscriptionStatus.Cancelled) {
    return makeResponse(true, `Subscription disabled already`, {}, 200);
  }

  const response = await paystackService.disableSubscription({
    code: subscription.paystackSubscriptionCode,
    token: subscription.email_token!,
  });
  if (!response.status) {
    return makeResponse(false, "Paystack update failed", {}, 401);
  }

  const sub = await repository.findSubscriptionByIdAndUpdate(id, {
    status: SubscriptionStatus.Cancelled,
  });
  if (!sub) {
    return makeResponse(false, `Subscription failed to disable`, {}, 401);
  }

  return makeResponse(true, "Subscription disabled successfully", {}, 200);
};

export const enable = async (id: string) => {
  const subscription = await repository.findSubscriptionById(id);
  if (!subscription) {
    return makeResponse(false, `Subscription not found`, {}, 404);
  }

  if (subscription.status === SubscriptionStatus.Active) {
    return makeResponse(true, `Subscription enabled already`, {}, 200);
  }

  const response = await paystackService.enableSubscription({
    code: subscription.paystackSubscriptionCode,
    token: subscription.email_token!,
  });
  if (!response.status) {
    return makeResponse(false, "Paystack update failed", {}, 401);
  }

  const sub = await repository.findSubscriptionByIdAndUpdate(id, {
    status: SubscriptionStatus.Active,
  });
  if (!sub) {
    return makeResponse(false, `Subscription failed to disable`, {}, 401);
  }

  return makeResponse(true, "Subscription disabled successfully", {}, 200);
};

export const createSubscription = async (
  user: IUser,
  planId: string,
  authorizationCode: string,
  startDate?: Date
) => {
  const plan = await planRepository.findPlanByMatch({ _id: planId, isDeleted: false });
  if (!plan) {
    return makeResponse(false, `Plan not found`, {}, 404);
  }

  try {
    const response = await paystackService.createSubscription({
      customer: user.email,
      plan: plan.paystackPlanCode!,
      authorization: authorizationCode!,
      start_date: startDate,
    });

    if (!response.status) {
      return makeResponse(false, "Failed to create Paystack subscription", response, 400);
    }

    const subscription = await repository.createSubscription({
      user: user.id,
      plan: plan.id,
      paystackSubscriptionCode: response.data.subscription_code,
      authorizationCode: response.data.authorization.authorization_code,
      status: response.data.status,
      startDate: new Date(response.data.start),
      nextPaymentDate: response.data.next_payment_date,
      cron_expression: response.data.cron_expression,
      email_token: response.data.email_token,
    });

    return makeResponse(true, "Subscription created successfully", { subscription });
  } catch (error: any) {
    if (error.response?.data?.code === "duplicate_subscription") {
      try {
        const paystackSubs = await paystackService.listSubscriptions(user.email);

        if (paystackSubs.status && paystackSubs.data && paystackSubs.data.length > 0) {
          const existingPaystackSub = paystackSubs.data.find(
            (sub: any) =>
              sub.customer.email === user.email &&
              sub.plan.plan_code === plan.paystackPlanCode &&
              (sub.status === "active" || sub.status === "non-renewing")
          );

          if (existingPaystackSub) {
            const subscription = await repository.createSubscription({
              user: user.id,
              plan: plan.id,
              paystackSubscriptionCode: existingPaystackSub.subscription_code,
              authorizationCode: existingPaystackSub.authorization?.authorization_code,
              status: existingPaystackSub.status,
              startDate: new Date(existingPaystackSub.start),
              nextPaymentDate: existingPaystackSub.next_payment_date,
              cron_expression: existingPaystackSub.cron_expression,
              email_token: existingPaystackSub.email_token,
            });

            return makeResponse(true, "Subscription synced from Paystack successfully", {
              subscription,
            });
          }
        }

        return makeResponse(false, "No existing subscription found on Paystack", {}, 404);
      } catch (fetchError) {
        return makeResponse(
          false,
          "Error fetching existing subscription from Paystack",
          { error: fetchError },
          500
        );
      }
    }

    return makeResponse(false, "Error creating subscription", { error: error.message }, 500);
  }
};

export const hasRunningSubscription = async (user: IUser, planId: string) => {
  const localSub = await repository.findSubscriptionByMatch({
    user: user.id,
    plan: planId,
    status: SubscriptionStatus.Active,
  });
  if (localSub) return true;

  const plan = await planRepository.findPlanByMatch({ _id: planId, isDeleted: false });
  if (!plan) return false;

  const paystackSubs = await paystackService.listSubscriptions(user.email);
  if (paystackSubs.status && paystackSubs.data) {
    const alreadyActive = paystackSubs.data.find(
      (sub: any) =>
        sub.customer.email === user.email &&
        sub.plan.plan_code === plan.paystackPlanCode &&
        (sub.status === "active" || sub.status === "non-renewing")
    );
    if (alreadyActive) return true;
  }
  return false;
};

export const subscribe = async (user: IUser, payload: { planId: string }) => {
  const alreadySubscribed = await hasRunningSubscription(user, payload.planId);
  if (alreadySubscribed) {
    return makeResponse(false, `User already on a plan, deactivate or unsubscribe first`, {}, 409);
  }

  const plan = await planRepository.findPlanById(payload.planId);
  if (!plan) {
    return makeResponse(false, `Plan not found`, {}, 404);
  }

  const response = await paystackService.createSubscription({
    customer: user.email,
    plan: plan.paystackPlanCode!,
    // authorization: payload.authorizationCode,
    // start_date: payload?.startDate
  });
  const subscription = await repository.createSubscription({
    user: user.id,
    plan: payload.planId,
    paystackSubscriptionCode: response.data.subscription_code,
    authorizationCode: response.data.authorization.authorization_code,
    status: response.data.status,
    startDate: new Date(),
    nextPaymentDate: response.data.next_payment_date,
    cron_expression: response.data.cron_expression,
    email_token: response.data.email_token,
  });

  if (!subscription) {
    return makeResponse(false, "Subscription creation failed, please try again");
  }

  return makeResponse(true, "Subscription added successfully", { subscription }, 201);
};
