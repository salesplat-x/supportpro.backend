import { Schema, model } from "mongoose";
import { ISubscription, SubscriptionStatus } from "../../typings/subscription";
import {string} from "joi";

const subscriptionSchema = new Schema<ISubscription>(
    {
        user: {
            type: Schema.Types.ObjectId,
            ref: "user",
            required: true,
        },
        plan: {
            type: Schema.Types.ObjectId,
            ref: "plan",
            required: true,
        },
        paystackSubscriptionCode: {
            type: String,
            required: true,
        },
        authorizationCode: {
            type: String,
            required: false,
        },
        email_token: {
            type: String,
            required: false
        },
        status: {
            type: String,
            enum: Object.values(SubscriptionStatus), 
            default: SubscriptionStatus.Active,
        },
        startDate: {
            type: Date,
            required: false
        },
        nextPaymentDate: {
            type: Date,
            required: false,
        },
        expiryDate: {
            type: Date,
            required: false,
        },
        cron_expression:{
            type: String,
            required: false
        },
        usage: {
            jobListingsUsed: {
                type: Number,
                default: 0,
            },
            candidatesAccessed: {
                type: Number,
                default: 0,
            },
            aiTestsUsed: {
                type: Number,
                default: 0,
            },
            lastResetDate: {
                type: Date,
                default: Date.now,
            },
        },
        history: [
            {
                description: {
                    type: String,
                    required: true,
                },
                author: {
                    type: Schema.Types.ObjectId,
                    ref: "user",
                    required: true,
                },
                date: {
                    type: Date,
                    default: Date.now,
                },
                action: {
                    type: String,
                    required: false,
                },
            },
        ],
    },
    {
        timestamps: true,
        toJSON: {
            transform: function (doc, ret) {
                delete ret.__v;
                delete ret.createdAt;
                delete ret.updatedAt;
            },
        },
    }
);

export default model<ISubscription>("subscription", subscriptionSchema);
