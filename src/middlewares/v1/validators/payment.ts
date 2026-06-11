import Joi from "joi";
import env from "../../../config/env";

/*export const webhook = Joi.object({
    headers: Joi.object({
        "verif-hash": Joi.string().required().valid(env.flwSecretHash).messages({
            "string.valid": "Invalid secret hash.",
            "string.base": "Invalid secret hash.",
            "any.only": "Invalid secret hash.",
        }),
    }),
}).required();*/

export const initializePayment = Joi.object({
  body: Joi.object({
    amount: Joi.number().optional(),
    planId: Joi.string().optional(),
  }).xor("amount", "planId"),
}).required();

export const verify = Joi.object({
  body: Joi.object({
    reference: Joi.string().required(),
  }),
}).required();
