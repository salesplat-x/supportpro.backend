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
            required: true, // in kobo, e.g., ₦5000 = 500000
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
        is_deleted: {
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
