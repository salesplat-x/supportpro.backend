import {PaymentMethod} from "./payment";

export const BillingInterval = {
    Daily: "daily",
    Weekly: "weekly",
    Monthly: "monthly",
    Yearly: "yearly",
} as const;

export interface IPlan {
    name: string;
    amount: number;
    interval: TBillingInterval;
    paystackPlanCode: string;
}

export type TBillingInterval = (typeof BillingInterval)[keyof typeof BillingInterval];