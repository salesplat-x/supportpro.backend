import axios, { AxiosRequestConfig } from "axios";
import { createHmac } from "crypto";
import { Request } from "express";
import env from "../../config/env.js";
import { BillingInterval } from "../../types/enums.js";
import type { Plan } from "../../entities/Plan.js";

// ---- Paystack type definitions ----

export interface IPaystackConfig {
  amount: number;
  email: string;
  currency: string;
  reference?: string;
  callback_url?: string;
  metadata?: Record<string, string>;
  channels?: string[];
  plan?: string;
}

export interface IPlanConfig {
  name: string;
  interval: string;
  amount: number;
  monthlyAmount?: number;
  currency: string;
  description: string;
}

export interface IPlanUpdateConfig {
  name?: string;
  interval?: string;
  amount?: number;
  currency?: string;
  description?: string;
  update_existing_subscriptions?: boolean;
}

export interface ISubConfig {
  customer: string;
  plan: string;
  authorization?: string;
  start_date?: Date;
}

export interface ICreatePaystackCustomer {
  email: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
}

export interface ISubDisOrEnableConfig {
  code: string;
  token: string;
}

export interface IPaystackInitRes {
  status: boolean;
  message: string;
  data: { authorization_url: string; access_code: string; reference: string };
}

export interface IPlanUpdateRes {
  status: boolean;
  message: string;
}

export interface ISubCreateRes {
  status: boolean;
  message: string;
  data: {
    customer: string;
    plan: number;
    status: string;
    amount: number;
    subscription_code: string;
    email_token: string;
    id: number;
    authorization: { authorization_code: string };
    cron_expression?: string;
    next_payment_date?: Date;
  };
}

export interface ISubGenerateLinkRes {
  status: boolean;
  message: string;
  data: { link: string };
}

export interface IPaystackCreatePlanRes {
  status: boolean;
  message: string;
  data: { plan_code: string; name: string; amount: number; interval: string };
}

export const PaymentVerificationStatus = {
  ChargeCompleted: "charge.completed",
  TransferCompleted: "transfer.completed",
  Successful: "successful",
  Success: "success",
  Failed: "failed",
  Error: "error",
} as const;

// ---- Paystack service functions ----

export const initializePayment = async (payload: IPaystackConfig): Promise<IPaystackInitRes> => {
  const config = {
    method: "post",
    url: `${env.paystackUrl}/transaction/initialize`,
    headers: {
      Authorization: `Bearer ${env.paystackSecretKey}`,
      "Content-Type": "application/json",
      "cache-control": "no-cache",
    },
    data: payload,
  };
  const response = await axios(config);
  return response.data as IPaystackInitRes;
};

export const verifyTransaction = async (reference: string) => {
  const config: AxiosRequestConfig = {
    method: "get",
    url: `${env.paystackUrl}/transaction/verify/${reference}`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.paystackSecretKey}`,
    },
  };
  const response = await axios(config);
  return response.data as {
    status: boolean;
    data: {
      message: string;
      amount: number;
      status: string;
      plan: string;
      gateway_response: string;
      currency: string;
      authorization: { authorization_code: string };
    };
  };
};

export const webhookDataValidation = (req: Request): boolean => {
  const hash = createHmac("sha512", env.paystackSecretKey!)
    .update(JSON.stringify(req.body))
    .digest("hex");
  return hash === req.headers["x-paystack-signature"];
};

export const generatePaymentObject = (
  amount: number,
  email: string,
  plan?: string,
  currency = "NGN"
): IPaystackConfig => {
  if (!plan) amount *= 100;
  const config: IPaystackConfig = {
    amount,
    email,
    currency,
    plan,
    callback_url: `${env.website}`,
    channels: ["card", "bank"],
  };
  if (plan) config.channels = ["card"];
  return config;
};

export const generatePlanObject = (plan: Plan): IPlanConfig => {
  let amount = plan.amount * 100;
  if (plan.interval === BillingInterval.Annually) amount *= 12;
  return {
    name: plan.name,
    interval: plan.interval,
    amount,
    monthlyAmount: plan.amount,
    currency: plan.currency,
    description: plan.description,
  };
};

export const createPlan = async (payload: IPlanConfig): Promise<IPaystackCreatePlanRes> => {
  const response = await axios({
    method: "post",
    url: `${env.paystackUrl}/plan`,
    headers: {
      Authorization: `Bearer ${env.paystackSecretKey}`,
      "Content-Type": "application/json",
    },
    data: payload,
  });
  return response.data as IPaystackCreatePlanRes;
};

export const updatePlan = async (
  planCode: string,
  payload: Partial<IPlanUpdateConfig>
): Promise<IPlanUpdateRes> => {
  const response = await axios({
    method: "put",
    url: `${env.paystackUrl}/plan/${planCode}`,
    headers: {
      Authorization: `Bearer ${env.paystackSecretKey}`,
      "Content-Type": "application/json",
    },
    data: payload,
  });
  return response.data as IPlanUpdateRes;
};

export const createSubscription = async (payload: ISubConfig): Promise<ISubCreateRes> => {
  const response = await axios({
    method: "post",
    url: `${env.paystackUrl}/subscription`,
    headers: {
      Authorization: `Bearer ${env.paystackSecretKey}`,
      "Content-Type": "application/json",
    },
    data: payload,
  });
  return response.data as ISubCreateRes;
};

export const createCustomer = async (payload: ICreatePaystackCustomer): Promise<ISubCreateRes> => {
  const response = await axios({
    method: "post",
    url: `${env.paystackUrl}/customer`,
    headers: {
      Authorization: `Bearer ${env.paystackSecretKey}`,
      "Content-Type": "application/json",
    },
    data: payload,
  });
  return response.data as ISubCreateRes;
};

export const enableSubscription = async (payload: ISubDisOrEnableConfig): Promise<IPlanUpdateRes> => {
  const response = await axios({
    method: "post",
    url: `${env.paystackUrl}/subscription/enable`,
    headers: {
      Authorization: `Bearer ${env.paystackSecretKey}`,
      "Content-Type": "application/json",
    },
    data: payload,
  });
  return response.data as IPlanUpdateRes;
};

export const disableSubscription = async (payload: ISubDisOrEnableConfig): Promise<IPlanUpdateRes> => {
  const response = await axios({
    method: "post",
    url: `${env.paystackUrl}/subscription/disable`,
    headers: {
      Authorization: `Bearer ${env.paystackSecretKey}`,
      "Content-Type": "application/json",
    },
    data: payload,
  });
  return response.data as IPlanUpdateRes;
};

export const generateUpdateSubscriptionLink = async (
  subscriptionCode: string
): Promise<ISubGenerateLinkRes> => {
  const response = await axios({
    method: "get",
    url: `${env.paystackUrl}/subscription/${subscriptionCode}/manage/link`,
    headers: {
      Authorization: `Bearer ${env.paystackSecretKey}`,
      "Content-Type": "application/json",
    },
  });
  return response.data as ISubGenerateLinkRes;
};

export const listSubscriptions = async (customerEmail: string) => {
  const response = await axios({
    method: "get",
    url: `${env.paystackUrl}/subscription?email=${encodeURIComponent(customerEmail)}`,
    headers: {
      Authorization: `Bearer ${env.paystackSecretKey}`,
      "Content-Type": "application/json",
    },
  });
  return response.data;
};
