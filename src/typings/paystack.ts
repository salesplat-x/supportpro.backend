import {boolean} from "joi";
import {TBillingInterval} from "./plan";

export interface IPaystackConfig {
    amount: number;
    email: string;
    currency: string;
    reference?: string;
    callback_url?: string;
    metadata?: Record<string, string>;
    channels?: string[];
    split_code?: string;
    subaccount?: string;
    transaction_charge?: string;
    bearer?: string;
    plan?: string;
}

export interface IPlanConfig {
    name: string;
    interval: TBillingInterval;
    amount: number;
    currency: string;
    description: string
}

export interface ISubConfig {
    customer: string;
    plan: string;
    authorization: string;
    start_date?: string;
}

export interface IPlanUpdateConfig {
    name?: string;
    interval?: TBillingInterval;
    amount?: number;
    currency?: string;
    description?: string;
    update_existing_subscriptions?: boolean;
}

export interface IPaystackInitRes {
    status: boolean;
    message: string;
    data: {
        authorization_url: string;
        access_code: string;
        reference: string;
    };
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
        integration: number;
        domain: string;
        start: number;
        status: string;
        quantity: number;
        amount: number;
        authorization: {
            authorization_code: string;
            bin: string;
            last4: string;
            exp_month: string;
            exp_year: string;
            channel: string;
            card_type: string;
            bank: string;
            country_code: string;
            brand: string;
            reusable: boolean;
            signature: string;
            account_name: string;
        };
        invoice_limit: number;
        split_code?: string;
        subscription_code: string;
        email_token: string;
        id: number;
        cancelledAt?: string;
        createdAt: string;
        updatedAt: string;
        cron_expression?: string;
        next_payment_date?: string;
    }
}

export interface ISubGenerateLinkRes {
    status: boolean;
    message: string;
    data: {
        link: string
    }
}

export interface ISubDisOrEnableConfig {
    code: string;
    token: string
}

export interface IPaystackCreatePlanRes {
    status: boolean;
    message: string,
    data: {
        name: string,
        interval: string,
        amount: number,
        description: string,
        integration: number,
        domain: string,
        currency: string,
        plan_code: string,
        invoice_limit?: number,
        send_invoices: boolean,
        send_sms: boolean,
        hosted_page: boolean,
        migrate?: boolean,
        is_archived?: boolean,
        id: number,
        createdAt: string,
        updatedAt: string
    }
}

export const PaymentVerificationStatus = {
    ChargeCompleted: "charge.completed",
    TransferCompleted: "transfer.completed",
    Successful: "successful",
    Success: "success",
    Failed: "failed",
    Error: "error",
} as const;