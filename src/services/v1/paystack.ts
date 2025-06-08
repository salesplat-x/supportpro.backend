import axios, { AxiosRequestConfig } from "axios";
import env from "../../config/env";
import {
    IPaystackInitRes,
    IPaystackConfig,
    IPaystackCreatePlanRes,
    IPlanConfig,
    IPlanUpdateConfig, IPlanUpdateRes
} from "../../typings/paystack";
import { IUser } from "../../typings/user";
import { createHmac } from "crypto";
import { Request } from "express";
import {IPlan} from "../../typings/plan";
import plan from "../../models/v1/plan";
import {AtLeastOne} from "../../helpers/utils";

export const makePayment = async (
    payload: IPaystackConfig
): Promise<IPaystackInitRes> => {
    let config = {
        method: "post",
        url: `${env.paystackUrl}/transaction/initialize`,
        headers: {
            Authorization: `Bearer ${env.paystackSecretKey}`,
            "Content-Type": "application/json",
            "cache-control": "no-cache",
        },
        data: payload,
    };

    const charge = await axios(config);

    return new Promise((resolve, reject) => {
        axios(config)
            .then((response) => {
                const reference = charge.data.data.reference;
                const link = charge.data.data.authorization_url;
                return resolve(response.data);
            })
            .catch((error) => {
                return reject(error);
            });
    });
};

export const verifyTransaction = async (payload: {
    reference: string;
}): Promise<{
    status: boolean;
    data: {
        message: string;
        amount: number;
        status: string;
        gateway_response: string;
        id: number;
        tx_ref: string;
        currency: string;
        amount_settled: number;
        charged_amount: number;
    };
}> => {
    const config: AxiosRequestConfig = {
        method: "get",
        url: `${env.paystackUrl}/transaction/verify/${payload.reference}`,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.paystackSecretKey}`,
        },
    };
    const response: any = await axios(config);
    return response.data;
};

export const webhookDataValidation = (req: Request) => {
    const hash = createHmac("sha512", env.paystackSecretKey!)
        .update(JSON.stringify(req.body))
        .digest("hex");
    return hash == req.headers["x-paystack-signature"];

};

export const generatePaymentObject = (
    amount: number,
    initiator: IUser
): IPaystackConfig => {
    return {
        amount: amount * 100,
        email: initiator.email as string,
        currency: "NGN",
        // reference: `supportpro-${Date.now()}-${Math.floor(Math.random() * 9999999)}`,
        callback_url: `${env.website}/orders`,
        channels: ["card", "bank"],
    };
};

export const generatePlanObject = (
    plan: IPlan
): IPlanConfig => {
    return {
        name: plan.name,
        interval: plan.interval,
        amount: plan.amount * 100,
        currency: plan.currency,
        description: plan.description
    }
}

export const createPlan = async (
    payload: IPlanConfig
): Promise<IPaystackCreatePlanRes> => {
    let config = {
        method: "post",
        url: `${env.paystackUrl}/plan`,
        headers: {
            Authorization: `Bearer ${env.paystackSecretKey}`,
            "Content-Type": "application/json",
            "cache-control": "no-cache",
        },
        data: payload,
    };

    const charge = await axios(config);

    return new Promise((resolve, reject) => {
        axios(config)
            .then((response) => {
                console.log(response.data);
                return resolve(response.data);
            })
            .catch((error) => {
                return reject(error);
            });
    });
};

export const updatePlan = async (
    planCode: string,
    payload: AtLeastOne<IPlanUpdateConfig>
): Promise<IPlanUpdateRes> => {
    let config = {
        method: "put",
        url: `${env.paystackUrl}/plan/:${planCode}`,
        headers: {
            Authorization: `Bearer ${env.paystackSecretKey}`,
            "Content-Type": "application/json",
            "cache-control": "no-cache",
        },
        data: payload,
    };

    const charge = await axios(config);

    return new Promise((resolve, reject) => {
        axios(config)
            .then((response) => {
                console.log(response.data);
                return resolve(response.data);
            })
            .catch((error) => {
                return reject(error);
            });
    });
};