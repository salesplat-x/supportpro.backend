export const BillingInterval = {
    Daily: "daily",
    Weekly: "weekly",
    Monthly: "monthly",
    Yearly: "yearly",
} as const;

export const Currency = {
    naira: "NGN"
}

export interface IPlan {
    name: string;
    amount: number;
    interval: TBillingInterval;
    paystackPlanCode?: string;
    currency: TCurrency;
    description: string;
    update_existing_subscriptions?: boolean;
    is_deleted?: boolean;
}

export type TBillingInterval = (typeof BillingInterval)[keyof typeof BillingInterval];
export type TCurrency = (typeof Currency)[keyof typeof Currency];