import { Types } from "mongoose";

export const SubscriptionStatus = {
    Active: "active",
    Pending: "pending",
    NonRenewing: "non-renewing",
    Attention: "attention",
    Completed: "completed",
    Cancelled: "cancelled",
    Expired: "expired",
} as const;

export interface ISubscriptionUsage {
    jobListingsUsed: number;
    candidatesAccessed: number;
    aiTestsUsed: number;
    lastResetDate: Date;
}

export interface ISubscription {
    user: Types.ObjectId | string;
    plan: Types.ObjectId | string;
    paystackSubscriptionCode: string;
    authorizationCode?: string;
    status: TSubscriptionStatus;
    startDate?: Date;
    nextPaymentDate?: Date;
    expiryDate?: Date;
    cron_expression?: string;
    email_token?: string;
    usage?: ISubscriptionUsage;
    history?: {
        description: string;
        author: Types.ObjectId;
        date?: Date;
        action?: string;
    }[];
}

export interface ISubFindConfig {
    user?: Types.ObjectId | string;
    plan?: Types.ObjectId | string;
    status?: TSubscriptionStatus;
}

export type TSubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];