import Joi from "joi";
import { ApplicationStatus } from "../../../typings/application";

export const getApplications = Joi.object({
  query: Joi.object({
    roleId: Joi.string().optional(),
    experienceLevel: Joi.string().optional(),
    job: Joi.string().optional(),

    limit: Joi.number(),
    offset: Joi.number(),
    sort: Joi.string().valid("asc", "desc"),
  }),
}).required();

export const getApplication = Joi.object({
  params: Joi.object({
    _id: Joi.string().required(),
  }),
}).required();

export const updateApplicationStatus = Joi.object({
  params: Joi.object({
    _id: Joi.string().required(),
  }),
  body: Joi.object({
    status: Joi.string()
      .valid(...Object.values(ApplicationStatus))
      .required(),
  }),
}).required();
