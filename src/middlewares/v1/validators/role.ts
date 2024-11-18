import Joi from "joi";
import { IRole } from "../../../typings/role";

export const role = Joi.object({
  body: Joi.object<IRole>({
    name: Joi.string().required(),
    description: Joi.string().required(),
  }),
}).required();

export const roleId = Joi.object({
  params: Joi.object({
    _id: Joi.string().required(),
  }),
}).required();

export const allRoles = Joi.object({
  query: Joi.object({
    limit: Joi.number(),
    offset: Joi.number(),
    sort: Joi.string().valid("asc", "desc"),
  }),
}).required();

export const roleQuestions = Joi.object({
  params: Joi.object({
    _id: Joi.string().required(),
  }),
  query: Joi.object({
    limit: Joi.number(),
    offset: Joi.number(),
    sort: Joi.string().valid("asc", "desc"),
  }),
}).required();
