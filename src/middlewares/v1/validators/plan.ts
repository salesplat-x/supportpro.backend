import Joi from 'joi';
import {BillingInterval, Currency, IPlan} from "../../../typings/plan";

export const create = Joi.object({
    body: Joi.object<IPlan>({
        name: Joi.string().min(1).required(),
        amount: Joi.number().positive().required(),
        interval: Joi.string()
            .valid(...Object.values(BillingInterval))
            .required(),
        paystackPlanCode: Joi.string().optional(), // Can add .allow(null) if nullable
        currency: Joi.string()
            .valid(...Object.values(Currency))
            .required(),
        description: Joi.string().min(1).required(),
        features: Joi.array().items(Joi.string()).optional()
    }),
}).required();

export const update = Joi.object({
    body: Joi.object({
        name: Joi.string().optional(),
        interval: Joi.string().valid(...Object.values(BillingInterval)).optional(),
        amount: Joi.number().positive().optional(),
        currency: Joi.string().valid(...Object.values(Currency)).optional(),
        description: Joi.string().optional(),
        features: Joi.array().items(Joi.string()).optional()
    }).min(1),
    params: Joi.object({
        _id: Joi.string().required()
    })
})

export const id = Joi.object({
    params: Joi.object({
        id: Joi.string().required()
    })
})
