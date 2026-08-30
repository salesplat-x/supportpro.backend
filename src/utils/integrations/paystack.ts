import axios, { AxiosRequestConfig } from "axios";
import { createHmac, timingSafeEqual } from "crypto";
import { Request } from "express";
import env from "../../config/env.js";
import { BillingInterval } from "../../types/enums.js";
import type { Plan } from "../../entities/Plan.js";

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

export interface VerifyTransactionResult {
  status: boolean;
  data: {
    message?: string;
    amount: number;
    status: string;
    plan?: string;
    gateway_response?: string;
    currency: string;
    reference: string;
    authorization?: { authorization_code?: string };
  };
}

export const PaymentVerificationStatus = {
  ChargeCompleted: "charge.completed",
  TransferCompleted: "transfer.completed",
  Successful: "successful",
  Success: "success",
  Failed: "failed",
  Error: "error",
} as const;

export const isDummyPaystack = (): boolean => env.paystackMode === "dummy";

const authHeaders = () => ({
  Authorization: `Bearer ${env.paystackSecretKey}`,
  "Content-Type": "application/json",
});

export const paymentCallbackUrl = (): string =>
  `${(env.website ?? "").replace(/\/$/, "")}/payment/verify`;

export const paystackPlanCodeForInterval = (interval: BillingInterval): string | undefined => {
  if (interval === BillingInterval.Annually) {
    return env.paystackPlanCodeAnnually || undefined;
  }
  return env.paystackPlanCodeMonthly || undefined;
};

export const initializePayment = async (payload: IPaystackConfig): Promise<IPaystackInitRes> => {
  if (isDummyPaystack()) {
    const reference = payload.reference ?? `DUMMY-${Date.now()}`;
    return {
      status: true,
      message: "Dummy authorization URL",
      data: {
        authorization_url: `${paymentCallbackUrl()}?reference=${encodeURIComponent(reference)}&trxref=${encodeURIComponent(reference)}`,
        access_code: "dummy_access",
        reference,
      },
    };
  }

  const response = await axios({
    method: "post",
    url: `${env.paystackUrl}/transaction/initialize`,
    headers: authHeaders(),
    data: payload,
  });
  return response.data as IPaystackInitRes;
};

export const verifyTransaction = async (reference: string): Promise<VerifyTransactionResult> => {
  if (isDummyPaystack()) {
    return {
      status: true,
      data: {
        amount: 0,
        status: "success",
        currency: "NGN",
        reference,
        authorization: { authorization_code: "AUTH_DUMMY" },
      },
    };
  }

  const config: AxiosRequestConfig = {
    method: "get",
    url: `${env.paystackUrl}/transaction/verify/${encodeURIComponent(reference)}`,
    headers: authHeaders(),
  };
  const response = await axios(config);
  return response.data as VerifyTransactionResult;
};

const signatureFromRawBody = (rawBody: Buffer): string => {
  return createHmac("sha512", env.paystackSecretKey ?? "")
    .update(rawBody)
    .digest("hex");
};

export const webhookDataValidation = (req: Request): boolean => {
  const signature = req.headers["x-paystack-signature"];
  if (typeof signature !== "string" || !signature) return false;

  const rawBody = req.rawBody;
  if (!rawBody || rawBody.length === 0) return false;

  const hash = signatureFromRawBody(rawBody);
  const expected = Buffer.from(hash);
  const received = Buffer.from(signature);
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
};

export const isPaystackIpAllowed = (req: Request): boolean => {
  const allowlist = (env.whitelisted_ips ?? "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);
  if (allowlist.length === 0) return true;

  const forwarded = req.headers["x-forwarded-for"];
  const forwardedIp = typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : undefined;
  const ip = forwardedIp || req.ip || req.socket.remoteAddress || "";
  return allowlist.includes(ip);
};

export const generatePaymentObject = (
  amountKobo: number,
  email: string,
  options: {
    reference: string;
    planCode?: string;
    metadata?: Record<string, string>;
  }
): IPaystackConfig => {
  const config: IPaystackConfig = {
    amount: amountKobo,
    email,
    currency: "NGN",
    reference: options.reference,
    callback_url: paymentCallbackUrl(),
    channels: ["card"],
    metadata: options.metadata,
  };
  if (options.planCode) config.plan = options.planCode;
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
  if (isDummyPaystack()) {
    return {
      status: true,
      message: "Dummy plan",
      data: {
        plan_code: `PLN_DUMMY_${Date.now()}`,
        name: payload.name,
        amount: payload.amount,
        interval: payload.interval,
      },
    };
  }
  const response = await axios({
    method: "post",
    url: `${env.paystackUrl}/plan`,
    headers: authHeaders(),
    data: payload,
  });
  return response.data as IPaystackCreatePlanRes;
};

export const updatePlan = async (
  planCode: string,
  payload: Partial<IPlanUpdateConfig>
): Promise<IPlanUpdateRes> => {
  if (isDummyPaystack()) return { status: true, message: "Dummy update" };
  const response = await axios({
    method: "put",
    url: `${env.paystackUrl}/plan/${planCode}`,
    headers: authHeaders(),
    data: payload,
  });
  return response.data as IPlanUpdateRes;
};

export const createSubscription = async (payload: ISubConfig): Promise<ISubCreateRes> => {
  if (isDummyPaystack()) {
    return {
      status: true,
      message: "Dummy subscription",
      data: {
        customer: payload.customer,
        plan: 0,
        status: "active",
        amount: 0,
        subscription_code: `SUB_DUMMY_${Date.now()}`,
        email_token: "dummy_token",
        id: 0,
        authorization: { authorization_code: payload.authorization ?? "AUTH_DUMMY" },
      },
    };
  }
  const response = await axios({
    method: "post",
    url: `${env.paystackUrl}/subscription`,
    headers: authHeaders(),
    data: payload,
  });
  return response.data as ISubCreateRes;
};

export const createCustomer = async (payload: ICreatePaystackCustomer): Promise<ISubCreateRes> => {
  if (isDummyPaystack()) {
    return {
      status: true,
      message: "Dummy customer",
      data: {
        customer: payload.email,
        plan: 0,
        status: "active",
        amount: 0,
        subscription_code: "",
        email_token: "",
        id: 0,
        authorization: { authorization_code: "" },
      },
    };
  }
  const response = await axios({
    method: "post",
    url: `${env.paystackUrl}/customer`,
    headers: authHeaders(),
    data: payload,
  });
  return response.data as ISubCreateRes;
};

export const enableSubscription = async (
  payload: ISubDisOrEnableConfig
): Promise<IPlanUpdateRes> => {
  if (isDummyPaystack()) return { status: true, message: "Dummy enable" };
  const response = await axios({
    method: "post",
    url: `${env.paystackUrl}/subscription/enable`,
    headers: authHeaders(),
    data: payload,
  });
  return response.data as IPlanUpdateRes;
};

export const disableSubscription = async (
  payload: ISubDisOrEnableConfig
): Promise<IPlanUpdateRes> => {
  if (isDummyPaystack()) return { status: true, message: "Dummy disable" };
  const response = await axios({
    method: "post",
    url: `${env.paystackUrl}/subscription/disable`,
    headers: authHeaders(),
    data: payload,
  });
  return response.data as IPlanUpdateRes;
};

export const generateUpdateSubscriptionLink = async (
  subscriptionCode: string
): Promise<ISubGenerateLinkRes> => {
  if (isDummyPaystack()) {
    return { status: true, message: "Dummy link", data: { link: paymentCallbackUrl() } };
  }
  const response = await axios({
    method: "get",
    url: `${env.paystackUrl}/subscription/${subscriptionCode}/manage/link`,
    headers: authHeaders(),
  });
  return response.data as ISubGenerateLinkRes;
};

export const listSubscriptions = async (customerEmail: string) => {
  if (isDummyPaystack()) return { status: true, data: [] };
  const response = await axios({
    method: "get",
    url: `${env.paystackUrl}/subscription?email=${encodeURIComponent(customerEmail)}`,
    headers: authHeaders(),
  });
  return response.data;
};
