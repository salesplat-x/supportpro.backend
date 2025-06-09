import Joi from 'joi';
import {IPlan} from "../../../typings/plan";

// Replace these with your actual types
const billingIntervals = ['daily', 'weekly', 'monthly', 'annually'] as const;
const currencies = ['NGN'] as const;

export const create = Joi.object({
    body: Joi.object<IPlan>({
        name: Joi.string().min(1).required(),
        amount: Joi.number().positive().required(),
        interval: Joi.string()
            .valid(...billingIntervals)
            .required(),
        paystackPlanCode: Joi.string().optional(), // Can add .allow(null) if nullable
        currency: Joi.string()
            .valid(...currencies)
            .required(),
        description: Joi.string().min(1).required()
    }),
}).required();

export const update = Joi.object({
    body: Joi.object({
        name: Joi.string().optional(),
        interval: Joi.string().valid(...billingIntervals).optional(),
        amount: Joi.number().positive().optional(),
        currency: Joi.string().valid(...currencies).optional(),
        description: Joi.string().optional()
    }).min(1),
    params: Joi.object({
        _id: Joi.string().required()
    })
})

export const id = Joi.object({
    params: Joi.object({
        _id: Joi.string().required()
    })
})
