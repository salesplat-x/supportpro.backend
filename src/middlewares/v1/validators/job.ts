import Joi from "joi";
import { Experience } from "../../../typings/customs";
import { FetchJobs, IJob, JobStatus, TopTalents } from "../../../typings/job";
import {
  ApplicationStatus,
  ApplicationType,
} from "../../../typings/application";

export const job = Joi.object({
  body: Joi.object<IJob>({
    role: Joi.string().required(),
    aiConfig: Joi.string().optional(),
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
    aiConfig: Joi.string().optional(),
    description: Joi.string().optional(),
    experienceLevel: Joi.string()
      .optional()
      .valid(...Object.values(Experience)),
    status: Joi.string()
      .optional()
      .valid(...Object.values(JobStatus)),
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
    skills: Joi.array().items(Joi.string()).optional(),
    goals: Joi.array().items(Joi.string()).optional(),
  }),
}).required();

export const matchJob = Joi.object({
  params: Joi.object({
    _id: Joi.string().required(),
  }),
  query: Joi.object({
    incomplete: Joi.boolean().optional(),
  }),
}).required();

export const apply = Joi.object({
  params: Joi.object({
    jobId: Joi.string().required(),
  }),
}).required();

export const getApplications = Joi.object({
  params: Joi.object({
    jobId: Joi.string().required(),
  }),
  query: Joi.object({
    experience: Joi.string().optional(),
    minCvSimilarityScore: Joi.number().max(100).min(0).optional(),
    minPersonalizedScore: Joi.number().max(100).min(0).optional(),
    applicationType: Joi.string()
      .valid(...Object.values(ApplicationType))
      .optional(),
    applicationStatus: Joi.string()
      .valid(...Object.values(ApplicationStatus))
      .optional(),
    maxSalary: Joi.number().optional(),
    offset: Joi.number().optional(),
    skip: Joi.number().optional(),
  }),
}).required();

export const allJobs = Joi.object({
  query: Joi.object<FetchJobs>({
    roleId: Joi.string().optional(),
    experienceLevel: Joi.string().optional(),
    city: Joi.string().optional(),
    state: Joi.string().optional(),
    country: Joi.string().optional(),
    remote: Joi.string().optional(),
    postedBy: Joi.string().optional(),

    limit: Joi.number(),
    offset: Joi.number(),
    sort: Joi.string().valid("asc", "desc"),
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
