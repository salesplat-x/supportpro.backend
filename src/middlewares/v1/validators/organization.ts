import Joi from "joi";
import { IAIConfig } from "../../../typings/AIconfig";

export const aiConfig = Joi.object({
  body: Joi.object<IAIConfig>({
    prescreeningAssessment: Joi.boolean().required(),
    cvSimilarity: Joi.boolean().required(),
    personalizedAssessment: Joi.boolean().required(),
    personalityEvaluation: Joi.boolean().required(),
    recruiterGuide: Joi.array().items(Joi.string()).optional(),
  }),
}).required();
