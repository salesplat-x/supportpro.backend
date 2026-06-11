import Joi from "joi";
import { IQuestion, DichotomyPair, QuestionType } from "../../../typings/question";

export const question = Joi.object({
  body: Joi.object<IQuestion>({
    role: Joi.string().required(),
    question: Joi.string().required(),
    category: Joi.string().required(),
    criteria: Joi.string().required(),
  }),
}).required();

export const id = Joi.object({
  params: Joi.object({
    _id: Joi.string().required(),
  }),
}).required();

export const answers = Joi.object({
  body: Joi.object({
    roleId: Joi.string().required(),
    answers: Joi.object().pattern(Joi.string(), Joi.string()).required(),
  }),
}).required();

export const evaluatePersonality = Joi.object({
  body: Joi.object({
    jobId: Joi.string().required(),
    answers: Joi.object().pattern(Joi.string(), Joi.string()).required(),
  }),
}).required();

export const answersPersonalized = Joi.object({
  body: Joi.object({
    jobId: Joi.string().required(),
    answers: Joi.object().pattern(Joi.string(), Joi.string()).required(),
  }),
}).required();

export const getQuestions = Joi.object({
  query: Joi.object({
    questionType: Joi.string()
      .valid(...Object.values(QuestionType))
      .required(),
    jobId: Joi.string().when("questionType", {
      not: QuestionType.Prescreening,
      then: Joi.required(),
    }),
    roleId: Joi.string().when("questionType", {
      is: QuestionType.Prescreening,
      then: Joi.required(),
    }),
    talentId: Joi.string(),
    limit: Joi.number(),
    offset: Joi.number(),
    sort: Joi.string().valid("asc", "desc"),
  }),
}).required();

export const personalizedQuestions = Joi.object({
  body: Joi.object({
    jobId: Joi.string().required(),
    talentId: Joi.string().required(),
    recruiterGuide: Joi.array().items(Joi.string()),
  }),
}).required();

export const generatePersonalityQuestions = Joi.object({
  body: Joi.object({
    jobId: Joi.string().required(),
    dichotomyPair: Joi.string()
      .valid(...Object.values(DichotomyPair))
      .required(),
  }),
}).required();
