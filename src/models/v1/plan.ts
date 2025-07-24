import { Schema, model } from "mongoose";
import {IPlan, BillingInterval, Currency} from "../../typings/plan";

const planSchema = new Schema<IPlan>(
    {
        name: {
            type: String,
            required: true,
        },
        amount: {
            type: Number,
            required: true,
        },
        paystackAmount: {
            type: Number,
            required: true,
        },
        interval: {
            type: String,
            enum: Object.values(BillingInterval),
            required: true,
        },
        paystackPlanCode: {
            type: String,
            required: false,
        },
        currency: {
            type: String,
            enum: Object.values(Currency),
            required: true
        },
        update_existing_subscriptions: {
            type:Boolean,
            required: false
        },
        description: {
            type: String,
            required: true
        },
        features: {
            type: [String],
            required: false
        },
        isDeleted: {
            type: Boolean,
            default: false,
        },
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

export default model<IPlan>("plan", planSchema);
