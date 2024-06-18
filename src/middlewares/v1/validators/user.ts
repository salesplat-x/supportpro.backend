import Joi from "joi";
import { Experience } from "../../../typings/customs";
import { FetchProfiles } from "../../../typings/user";
import {
  ApplicationStatus,
  ApplicationType,
} from "../../../typings/application";

export const profile = Joi.object({
  body: Joi.object({
    bio: Joi.string().required(),
    cv: Joi.string().required(),
    experience: Joi.string()
      .required()
      .valid(...Object.values(Experience)),
    maxSalary: Joi.number().required(),
    minSalary: Joi.number().less(Joi.ref("maxSalary")).required(),
    role: Joi.array().items(Joi.string()),
  }),
}).required();

export const userId = Joi.object({
  params: Joi.object({
    _id: Joi.string().required(),
  }),
}).required();

export const userProfiles = Joi.object({
  query: Joi.object<FetchProfiles>({
    limit: Joi.number(),
    offset: Joi.number(),
    sort: Joi.string().valid("asc", "desc"),
    roleId: Joi.string().optional(),
    experience: Joi.string()
      .valid(...Object.values(Experience))
      .optional(),
    minScore: Joi.number().max(99).min(0).optional(),
    maxSalary: Joi.number().optional(),
    incomplete: Joi.boolean().optional(),
  }),
}).required();

export const applications = Joi.object({
  query: Joi.object({
    applicationType: Joi.string()
      .valid(...Object.values(ApplicationType))
      .optional(),
    applicationStatus: Joi.string()
      .valid(...Object.values(ApplicationStatus))
      .optional(),
    limit: Joi.number(),
    offset: Joi.number(),
    sort: Joi.string().valid("asc", "desc"),
  }),
}).required();
