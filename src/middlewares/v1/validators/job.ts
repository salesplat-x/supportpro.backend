import Joi from "joi";
import { Experience } from "../../../typings/customs";
import { IJob, TopTalents } from "../../../typings/job";

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
    remote: Joi.boolean().optional(),
    responsibilities: Joi.array().items(Joi.string()).optional(),
    recruiterGuide: Joi.array().items(Joi.string()).optional(),
    skills: Joi.array().items(Joi.string()).optional(),
    goals: Joi.array().items(Joi.string()).optional(),
  }),
}).required();

export const updateJob = Joi.object({
  params: Joi.object({
    _id: Joi.string().required(),
  }),
  body: Joi.object<IJob>({
    role: Joi.string().optional(),
    description: Joi.string().optional(),
    experienceLevel: Joi.string()
      .optional()
      .valid(...Object.values(Experience)),
    maxSalary: Joi.number().optional(),
    minSalary: Joi.number().less(Joi.ref("maxSalary")).optional(),
    address: Joi.string().optional(),
    location: Joi.object({
      city: Joi.string().required(),
      state: Joi.string().required(),
      country: Joi.string().required(),
    }).optional(),
    remote: Joi.boolean().optional(),
    responsibilities: Joi.array().items(Joi.string()).optional(),
    recruiterGuide: Joi.array().items(Joi.string()).optional(),
    skills: Joi.array().items(Joi.string()).optional(),
    goals: Joi.array().items(Joi.string()).optional(),
  }),
}).required();

export const matchJob = Joi.object({
  params: Joi.object({
    _id: Joi.string().required(),
  }),
  query: {
    incomplete: Joi.boolean().optional(),
  },
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

export const topTalents = Joi.object({
  params: Joi.object({
    jobId: Joi.string().required(),
  }),
  query: Joi.object({
    percentage: Joi.number().max(100).min(0).optional(),
    limit: Joi.number().optional(),
  }),
}).required();
