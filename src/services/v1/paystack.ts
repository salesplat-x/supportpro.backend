import axios, { AxiosRequestConfig } from "axios";
import env from "../../config/env";
import { IPaystackInitRes, IPaystackConfig } from "../../typings/paystack";
import { IUser } from "../../typings/user";
import { createHmac } from "crypto";
import { Request } from "express";

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
        // reference: `koneli-${Date.now()}-${Math.floor(Math.random() * 9999999)}`,
        callback_url: `${env.website}/orders`,
        channels: ["card", "bank"],
    };
};