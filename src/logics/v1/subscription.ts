import {IPlan} from "../../typings/plan";
import * as repository from "../../repository/v1/subscription"
import * as userRepository from "../../repository/v1/user"
import * as planRepository from "../../repository/v1/plan"
import * as paystackService from "../../services/v1/paystack";
import {makeResponse} from "../../helpers/response";
import {ISubFindConfig, ISubscription} from "../../typings/subscription";
import {AtLeastOne} from "../../helpers/utils";

export const create = async (payload: ISubscription) => {
    let existingSubscription = await repository.findSubscriptionByMatch({
        user: payload.user,
        plan: payload.plan,
        status: "active"
    });
    if (existingSubscription) {
        return makeResponse(
            false,
            `User already on a plan, deactivate or unsubscribe first`
        );
    }

    const plan = await planRepository.findPlanById(payload.plan);
    if (!plan){
        return makeResponse(false, `Plan not found`, {}, 404);
    }
    const user = await userRepository.findUserById(payload.user);
    if (!user) {
        return makeResponse(false, `User not found`, {}, 404);
    }
    const response = await paystackService.createSubscription({
        customer: user.email,
        plan: plan.paystackPlanCode!,
        authorization: payload.authorizationCode!,
        start_date: payload?.startDate
    })
    const subscription = await repository.createSubscription({
        user: payload.user,
        plan: payload.plan,
        paystackSubscriptionCode: response.data.subscription_code,
        authorizationCode: response.data.authorization.authorization_code,
        status: response.data.status,
        startDate: new Date(),
        nextPaymentDate: response.data.next_payment_date,
        cron_expression: response.data.cron_expression,
        email_token: response.data.email_token
    })

    if (!subscription) {
        return makeResponse(false, "Subscription creation failed, please try again");
    }

    return makeResponse(true, "Subscription added successfully", { subscription }, 201);
}

export const fetch = async () => {
    let subs = await repository.findAllSubscription();

    return makeResponse(true, "Subscriptions fetched successfully", { subs });
}

export const fetchOne = async (id: string) => {
    let sub = await repository.findSubscriptionById(id);
    if (!sub) {
        return makeResponse(false, `Subscription not found`, {}, 404);
    }

    return makeResponse(true, "Subscription fetched successfully", {
        sub,
    });
}

export const fetchByMatch = async (payload: AtLeastOne<ISubFindConfig>) => {
    let sub = await repository.findSubscriptionByMatch({
        $or: [
            { user: payload.user },
            { plan: payload.plan }
        ]
    })

    if (!sub) {
        return makeResponse(false, `Subscription not found`, {}, 404);
    }
    return makeResponse(true, "Subscription fetched successfully", {
        sub,
    });
}

export const disable = async (id: string) => {
    let subscription = await repository.findSubscriptionById(id);
    if (!subscription) {
        return makeResponse(false, `Subscription not found`, {}, 404);
    }

    if (subscription.status === 'complete') {
        return makeResponse(true, `Subscription disabled already`, {}, 200);
    }

    const response = await paystackService.disableSubscription({
        code: subscription.paystackSubscriptionCode,
        token: subscription.email_token!
    })
    if (!response.status) {
        return makeResponse(false, "Paystack update failed", {}, 401)
    }

    const sub = await repository.findSubscriptionByIdAndUpdate(id, {
        status: "complete"
    })
    if (!sub) {
        return makeResponse(false, `Subscription failed to disable`, {}, 401);
    }

    return makeResponse(true, "Subscription disabled successfully", {}, 200)
}

export const enable = async (id: string) => {
    let subscription = await repository.findSubscriptionById(id);
    if (!subscription) {
        return makeResponse(false, `Subscription not found`, {}, 404);
    }

    if (subscription.status === 'active') {
        return makeResponse(true, `Subscription enabled already`, {}, 200);
    }

    const response = await paystackService.enableSubscription({
        code: subscription.paystackSubscriptionCode,
        token: subscription.email_token!
    })
    if (!response.status) {
        return makeResponse(false, "Paystack update failed", {}, 401)
    }

    const sub = await repository.findSubscriptionByIdAndUpdate(id, {
        status: "active"
    })
    if (!sub) {
        return makeResponse(false, `Subscription failed to disable`, {}, 401);
    }

    return makeResponse(true, "Subscription disabled successfully", {}, 200)
}