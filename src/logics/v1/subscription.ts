import {IPlan} from "../../typings/plan";
import * as repository from "../../repository/v1/subscription"
import * as paystackService from "../../services/v1/paystack";
import {makeResponse} from "../../helpers/response";
import {AtLeastOne} from "../../helpers/utils";
import {IPlanUpdateConfig} from "../../typings/paystack";
import {ISubscription} from "../../typings/subscription";

export const create = async (payload: ISubscription) => {
    let existingSubscription = await repository.findSubscriptionByMatch({
        user: payload.user._id,
        plan: payload.plan._id
    });
    if (existingSubscription) {
        return makeResponse(
            false,
            `Plan with name ${payload.name} already exists`
        );
    }

    const initialConfig = paystackService.generatePlanObject(payload);
    const planResponse = await paystackService.createPlan(initialConfig);

    const plan = await repository.createPlan({
        name: initialConfig.name,
        amount: initialConfig.amount,
        interval: initialConfig.interval,
        currency: initialConfig.currency,
        description: initialConfig.description,
        paystackPlanCode: planResponse.data.plan_code
    });
    if (!plan) {
        return makeResponse(false, "Plan creation failed, please try again");
    }

    return makeResponse(true, "Plan added successfully", { plan }, 201);
}

export const fetch = async () => {
    let plans = await repository.findAllPlan();

    return makeResponse(true, "Plans fetched successfully", { plans });
}

export const fetchOne = async (planId: string) => {
    let plan = await repository.findPlanById(planId);
    if (!plan) {
        return makeResponse(false, `Plan not found`, {}, 404);
    }

    return makeResponse(true, "Plan fetched successfully", {
        plan,
    });
}

export const update = async (planId: string, payload: AtLeastOne<IPlanUpdateConfig>) => {
    let plan = await repository.findPlanById(planId);
    if (!plan) {
        return makeResponse(false, `Plan not found`, {}, 404);
    }

    if (payload.name) {
        payload.name = payload.name.toLowerCase();
        const existingPlan = await repository.findPlanByMatch({
            name: payload.name,
        });
        if (
            existingPlan &&
            existingPlan._id.toString() !== plan._id.toString()
        ) {
            return makeResponse(
                false,
                `A plan already exists with this name`,
                {},
                400
            );
        }
    }
    let planCode: string = "";
    if (plan.paystackPlanCode !== undefined) {
        planCode = plan.paystackPlanCode;
    }
    await paystackService.updatePlan(planCode, payload);

    plan = await repository.findPlanByIdAndUpdate(planId, payload);
    if (!plan) {
        return makeResponse(false, "Update operation failed");
    }

    return makeResponse(true, "Plan updated successfully", { plan }, 200)
}

export const deleteItem = async (planId: string) => {
    const plan = await repository.findPlanByIdAndDelete(planId);
    if (!plan) {
        return makeResponse(false, "Delete operation failed");
    }
    return makeResponse(true, "Plan deleted successfully", {}, 200);
}