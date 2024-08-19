import Joi from "joi";

export const getApplication = Joi.object({
  params: Joi.object({
    _id: Joi.string().required(),
  }),
}).required();
