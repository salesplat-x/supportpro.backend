import { Schema, model } from "mongoose";
import { IPayment, PaymentMethod, PaymentStatus } from "../../typings/payment";

const schema = new Schema<IPayment>(
    {
        user: {
            type: Schema.Types.ObjectId,
            ref: "user",
            required: true,
        },
        order: {
            type: Schema.Types.ObjectId,
            ref: "order",
            required: true,
        },
        amount: {
            type: Number,
            required: true,
        },
        reference: {
            type: String,
        },
        paystackRef: {
            type: String,
        },
        paymentLink: {
            type: String,
        },
        method: {
            type: String,
            enum: Object.values(PaymentMethod),
            required: true,
        },
        status: {
            type: String,
            enum: Object.values(PaymentStatus),
            default: PaymentStatus.Pending,
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
        initialConfig: Object,
        finalConfig: Object,
        paidAt: Date,
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

export default model<IPayment>("payment", schema);