import axios, { AxiosRequestConfig } from "axios";
import env from "../../config/env";
import {
    IPaystackInitRes,
    IPaystackConfig,
    IPaystackCreatePlanRes,
    IPlanConfig,
    IPlanUpdateConfig, IPlanUpdateRes, ISubConfig, ISubCreateRes, ISubDisOrEnableConfig, ISubGenerateLinkRes
} from "../../typings/paystack";
import { createHmac } from "crypto";
import { Request } from "express";
import {BillingInterval, IPlan} from "../../typings/plan";
import {AtLeastOne} from "../../helpers/utils";

export const initializePayment = async (
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

    return new Promise((resolve, reject) => {
        axios(config)
            .then((response) => {
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
        plan: string;
        gateway_response: string;
        id: number;
        tx_ref: string;
        currency: string;
        amount_settled: number;
        charged_amount: number;
        authorization: {
            authorization_code: string
        }
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
    email: string,
    plan?: string,
    currency = "NGN"
): IPaystackConfig => {
    const config: IPaystackConfig = {
        amount: amount * 100,
        email,
        currency,
        plan,
        callback_url: `${env.website}`,
        channels: ["card", "bank"],
    };

    if (plan) {
        config.channels = ["card"]
    }

    return config
};

export const generatePlanObject = (
    plan: IPlan
): IPlanConfig => {
    let amount = plan.amount * 100
    if (plan.interval == BillingInterval.Annually) {
        amount *= 12
    }
    return {
        name: plan.name,
        interval: plan.interval,
        amount,
        monthlyAmount: plan.amount * 100,
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

    return new Promise((resolve, reject) => {
        axios(config)
            .then((response) => {
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
        url: `${env.paystackUrl}/plan/${planCode}`,
        headers: {
            Authorization: `Bearer ${env.paystackSecretKey}`,
            "Content-Type": "application/json",
            "cache-control": "no-cache",
        },
        data: payload,
    };

    return new Promise((resolve, reject) => {
        axios(config)
            .then((response) => {
                return resolve(response.data);
            })
            .catch((error) => {
                return reject(error);
            });
    });
};

export const createSubscription = async (
    payload: ISubConfig
): Promise<ISubCreateRes> => {
    let config = {
        method: "post",
        url: `${env.paystackUrl}/subscription`,
        headers: {
            Authorization: `Bearer ${env.paystackSecretKey}`,
            "Content-Type": "application/json",
            "cache-control": "no-cache",
        },
        data: payload,
    };

    return new Promise((resolve, reject) => {
        axios(config)
            .then((response) => {
                return resolve(response.data);
            })
            .catch((error) => {
                return reject(error);
            });
    });
};
export const enableSubscription = async (
    payload: ISubDisOrEnableConfig
): Promise<IPlanUpdateRes> => {
    let config = {
        method: "post",
        url: `${env.paystackUrl}/subscription/enable`,
        headers: {
            Authorization: `Bearer ${env.paystackSecretKey}`,
            "Content-Type": "application/json",
            "cache-control": "no-cache",
        },
        data: payload,
    };

    return new Promise((resolve, reject) => {
        axios(config)
            .then((response) => {
                return resolve(response.data);
            })
            .catch((error) => {
                return reject(error);
            });
    });
};

export const disableSubscription = async (
    payload: ISubDisOrEnableConfig
): Promise<IPlanUpdateRes> => {
    let config = {
        method: "post",
        url: `${env.paystackUrl}/subscription/disable`,
        headers: {
            Authorization: `Bearer ${env.paystackSecretKey}`,
            "Content-Type": "application/json",
            "cache-control": "no-cache",
        },
        data: payload,
    };

    return new Promise((resolve, reject) => {
        axios(config)
            .then((response) => {
                return resolve(response.data);
            })
            .catch((error) => {
                return reject(error);
            });
    });
};

export const generateUpdateSubscriptionLink = async (
    payload: string
): Promise<ISubGenerateLinkRes> => {
    let config = {
        method: "get",
        url: `${env.paystackUrl}/subscription/${payload}/manage/link`,
        headers: {
            Authorization: `Bearer ${env.paystackSecretKey}`,
            "Content-Type": "application/json",
            "cache-control": "no-cache",
        },
        data: {},
    };

    return new Promise((resolve, reject) => {
        axios(config)
            .then((response) => {
                return resolve(response.data);
            })
            .catch((error) => {
                return reject(error);
            });
    });
};

export const listSubscriptions = async (customerEmail: string) => {
    const config = {
        method: "get",
        url: `${env.paystackUrl}/subscription?email=${encodeURIComponent(customerEmail)}`,
        headers: {
            Authorization: `Bearer ${env.paystackSecretKey}`,
            "Content-Type": "application/json",
        },
    };
    const response = await axios(config);
    return response.data;
};