import Joi from "joi";

export const organization = Joi.object({
  body: Joi.object({
    email: Joi.string().email().required(),
    name: Joi.string().required(),
    phone: Joi.string().required(),
    website: Joi.string().required(),
    address: Joi.string().required(),
    industry: Joi.string(),
    twitter: Joi.string(),
    linkedin: Joi.string(),
    facebook: Joi.string(),
  }),
}).required();
