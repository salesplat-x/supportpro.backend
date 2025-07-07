import Joi from 'joi';
import {ISubscription} from "../../../typings/subscription";
import {Types} from "mongoose";
const SubscriptionStatus = ['active', 'complete', '', ''] as const;


export const create = Joi.object({
    body: Joi.object<ISubscription>({
        user: Joi.object<Types.ObjectId>().required(),
        plan: Joi.object<Types.ObjectId>().required(),
        paystackSubscriptionCode: Joi.string().required(),
        authorizationCode: Joi.string().optional(),
        status: Joi.string()
            .valid(...Object.values(SubscriptionStatus))
            .required(),
        startDate: Joi.date().optional(),
        nextPaymentDate: Joi.date().optional(),
        cron_expression: Joi.string().optional(),
        email_token: Joi.string().optional(),
        history: Joi.array().items(
            Joi.object({
                description: Joi.string().required(),
                author: Types.ObjectId,
                date: Joi.date().optional(),
            })
        ).optional(),
    })
}).required();

export const id = Joi.object({
    params: Joi.object({
        id: Joi.string().required()
    })
})

export const find = Joi.object({
    body: Joi.object({
        user: Joi.object<Types.ObjectId>().optional(),
        plan: Joi.object<Types.ObjectId>().optional(),
    }).min(1)
})
