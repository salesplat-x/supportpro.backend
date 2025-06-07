import { Types } from "mongoose";


export const SubscriptionStatus = {
    Active: "active",
    Pending: "pending",
    Cancelled: "cancelled",
    Expired: "expired",
} as const;

export interface ISubscription {
    user: Types.ObjectId;
    plan: Types.ObjectId;
    paystackSubscriptionCode: string;
    authorizationCode: string;
    status: TSubscriptionStatus;
    startDate?: Date;
    nextPaymentDate?: Date;
    history?: {
        description: string;
        author: Types.ObjectId;
        date?: Date;
    }[];
}

export type TSubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];