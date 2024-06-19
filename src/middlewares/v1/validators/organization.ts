import Joi from "joi";
import { IAIConfig } from "../../../typings/AIconfig";

export const aiConfig = Joi.object({
  body: Joi.object<IAIConfig>({
    prescreeningAssessment: Joi.boolean().required(),
    cvSimilarity: Joi.boolean().required(),
    personalizedAssessment: Joi.boolean().required(),
    personalityEvaluation: Joi.boolean().required(),
    noPersonalizedQuestions: Joi.number().optional(),
    recruiterGuide: Joi.array().items(Joi.string()).optional(),
  }),
}).required();

export const organization = Joi.object({
  body: Joi.object({
    email: Joi.string().email().required(),
    name: Joi.string().required(),
    phone: Joi.string().required(),
    website: Joi.string().required(),
    address: Joi.string().required(),
    industry: Joi.string(),
    twitter: Joi.string(),
    linkedin: Joi.string(),
    facebook: Joi.string(),
  }),
}).required();
