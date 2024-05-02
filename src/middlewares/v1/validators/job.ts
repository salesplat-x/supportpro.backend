import Joi from "joi";
import { Experience } from "../../../typings/customs";
import { IJob } from "../../../typings/job";

export const job = Joi.object({
  body: Joi.object<IJob>({
    role: Joi.string().required(),
    description: Joi.string().required(),
    experienceLevel: Joi.string()
      .required()
      .valid(...Object.values(Experience)),
    maxSalary: Joi.number().required(),
    minSalary: Joi.number().less(Joi.ref("maxSalary")).required(),
    address: Joi.string().optional(),
    location: Joi.object({
      city: Joi.string().required(),
      state: Joi.string().required(),
      country: Joi.string().required(),
    }).optional(),
    remote: Joi.boolean().required(),
    responsibilities: Joi.array().items(Joi.string()).optional(),
    skills: Joi.array().items(Joi.string()).optional(),
    goals: Joi.array().items(Joi.string()).optional(),
  }),
}).required();

export const jobId = Joi.object({
  params: Joi.object({
    _id: Joi.string().required(),
  }),
}).required();

export const allJobs = Joi.object({
  query: Joi.object({
    limit: Joi.number(),
    offset: Joi.number(),
    sort: Joi.string().valid("asc", "desc"),
    roleId: Joi.string().optional(),
  }),
}).required();

export const jobQuery = Joi.object({
  query: Joi.object({
    role: Joi.string().optional(),
    experienceLevel: Joi.string()
      .valid(...Object.values(Experience))
      .optional(),
    maxSalary: Joi.number().optional(),
    minSalary: Joi.number().optional(),
    remote: Joi.boolean().optional(),
  }),
}).required();
