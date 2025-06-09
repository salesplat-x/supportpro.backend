import { Schema, model } from "mongoose";
import { ISubscription, SubscriptionStatus } from "../../typings/subscription";

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
            required: true,
        },
        email_token: {
            type: String,
            required: false
        },
        status: {
            type: String,
            enum: Object.values(SubscriptionStatus), // e.g. active, pending, cancelled
            default: SubscriptionStatus.Pending,
        },
        startDate: {
            type: Date,
        },
        nextPaymentDate: {
            type: Date,
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
