import { Document, Types } from "mongoose";
import { IUser } from "./user";

export interface IPayment {
    user: string | Types.ObjectId;
    plan?: string | Types.ObjectId;
    amount: number;
    currency: string;
    // method: TPaymentMethod;
    status?: TPaymentStatus;
    paymentLink?: string;
    reference?: string;
    paystackRef?: string;
    initialConfig?: object;
    finalConfig?: object;
    paidAt?: Date;
    history?: {
        description: string;
        author: string | Types.ObjectId | IUser;
        date: Date;
    }[];
}

export interface Payment extends Document, IPayment {}

export const PaymentStatus = {
    Pending: "pending",
    Failed: "failed",
    Cancelled: "cancelled",
    Completed: "completed",
} as const;

export type TPaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const PaymentMethod = {
    Paystack: "paystack",
} as const;

export type TPaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];