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
