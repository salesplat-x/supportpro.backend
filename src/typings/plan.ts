import { Document, Types } from "mongoose";

export const BillingInterval = {
    Daily: "daily",
    Weekly: "weekly",
    Monthly: "monthly",
    Annually: "annually",
} as const;

export const Currency = {
    ngn: "NGN",
    usd: "USD"
}

export interface IPlan extends Document {
    _id?: Types.ObjectId | string;
    name: string;
    amount: number;
    interval: TBillingInterval;
    paystackPlanCode?: string;
    currency: TCurrency;
    description: string;
    features?: string[];
    update_existing_subscriptions?: boolean;
    isDeleted?: boolean;
}

export type TBillingInterval = (typeof BillingInterval)[keyof typeof BillingInterval];
export type TCurrency = (typeof Currency)[keyof typeof Currency];