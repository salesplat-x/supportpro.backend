import Joi from "joi";

export const sendMessage = Joi.object({
  body: Joi.object({
    application: Joi.string(),
    content: Joi.string().required(),
    recipient: Joi.string().required(),
  }),
}).required();

export const broadcastMessage = Joi.object({
  body: Joi.object({
    application: Joi.string().required(),
    content: Joi.string().required(),
  }),
}).required();

export const acknowledge = Joi.object({
  body: Joi.object({
    acknowledge: Joi.boolean().required(),
  }),
  params: Joi.object({
    id: Joi.string().required(),
  }),
}).required();

export const fetchApplicationMessages = Joi.object({
  query: Joi.object({
    application: Joi.string(),
    limit: Joi.number(),
    offset: Joi.number().optional(),
  }),
}).required();
