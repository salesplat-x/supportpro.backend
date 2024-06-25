import Joi from "joi";
import { IAIConfig } from "../../../typings/AIconfig";

export const aiConfig = Joi.object({
  body: Joi.object<IAIConfig>({
    name: Joi.string().required(),
    prescreeningAssessment: Joi.boolean().required(),
    minPrescreeningScore: Joi.number().optional(),
    cvSimilarity: Joi.boolean().required(),
    minCvSimilarityScore: Joi.number().optional(),
    noOfCvSimilarCandidates: Joi.number().max(20).optional(),
    personalizedAssessment: Joi.boolean().required(),
    noPersonalizedQuestions: Joi.number().max(20).optional(),
    personalityEvaluation: Joi.boolean().required(),
    uploadedQuestions: Joi.array().items(Joi.string()).optional(),
    recruiterGuide: Joi.string().optional(),
  }),
}).required();

export const update = Joi.object({
  params: Joi.object({
    _id: Joi.string().required(),
  }),
  body: Joi.object<IAIConfig>({
    name: Joi.string().optional(),
    prescreeningAssessment: Joi.boolean().optional(),
    minPrescreeningScore: Joi.number().optional(),
    cvSimilarity: Joi.boolean().optional(),
    minCvSimilarityScore: Joi.number().optional(),
    noOfCvSimilarCandidates: Joi.number().max(20).optional(),
    personalizedAssessment: Joi.boolean().optional(),
    noPersonalizedQuestions: Joi.number().max(20).optional(),
    personalityEvaluation: Joi.boolean().optional(),
    uploadedQuestions: Joi.string().optional(),
    recruiterGuide: Joi.string().optional(),
  }),
}).required();

export const id = Joi.object({
  params: Joi.object({
    _id: Joi.string().required(),
  }),
}).required();
