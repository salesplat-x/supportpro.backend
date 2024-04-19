import Joi from "joi";
import { Experience } from "../../../typings/customs";

export const job = Joi.object({
  body: Joi.object({
    role: Joi.string().required(),
    description: Joi.string().required(),
    experienceLevel: Joi.string()
      .required()
      .valid(...Object.values(Experience)),
    maxSalary: Joi.number().required(),
    minSalary: Joi.number().required(),
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
