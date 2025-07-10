import {IPlan} from "../../typings/plan";
import * as repository from "../../repository/v1/plan"
import * as paystackService from "../../services/v1/paystack";
import {makeResponse} from "../../helpers/response";
import {AtLeastOne} from "../../helpers/utils";
import {IPlanUpdateConfig} from "../../typings/paystack";

export const create = async (payload: IPlan) => {
    let existingPlan = await repository.findPlanByMatch({
        name: payload.name.toLowerCase(),
    });
    if (existingPlan) {
        return makeResponse(
            false,
            `Plan with name ${payload.name} already exists`
        );
    }

    const initialConfig = paystackService.generatePlanObject(payload);
    const planResponse = await paystackService.createPlan(initialConfig);

    const plan = await repository.createPlan({
        ...initialConfig,
        features: payload.features,
        paystackPlanCode: planResponse.data.plan_code
    });
    if (!plan) {
        return makeResponse(false, "Plan creation failed, please try again");
    }

    return makeResponse(true, "Plan added successfully", { plan }, 201);
}

export const fetch = async (payload: {currency?: string, interval?: string}) => {
    let plans = await repository.findPlansByMatch({
        ...payload,
        is_deleted: false
    });

    return makeResponse(true, "Plans fetched successfully", { plans });
}

export const fetchOne = async (planId: string) => {
    let plan = await repository.findPlanById(planId);
    if (!plan || plan.is_deleted === true) {
        return makeResponse(false, `Plan not found or deleted`, {}, 404);
    }

    return makeResponse(true, "Plan fetched successfully", {
        plan,
    });
}

export const update = async (planId: string, payload: AtLeastOne<IPlanUpdateConfig>) => {
    let plan = await repository.findPlanById(planId);
    if (!plan || plan.is_deleted === true) {
        return makeResponse(false, `Plan not found or deleted`, {}, 404);
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
    const plan = await repository.findPlanByIdAndUpdate(planId, {
        is_deleted: true
    });
    if (!plan) {
        return makeResponse(false, "Delete operation failed");
    }
    return makeResponse(true, "Plan deleted successfully", {}, 200);
}