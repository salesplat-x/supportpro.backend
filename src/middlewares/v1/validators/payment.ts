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

export const verify = Joi.object({
    params: Joi.object({
        id: Joi.string().required(),
        status: Joi.string().optional(),
        transaction_id: Joi.string().optional(),
    }),
}).required();