import Joi from "joi";
import { IAnswerQuestion, IQuestion } from "../../../typings/question";

export const question = Joi.object({
  body: Joi.object<IQuestion>({
    role: Joi.string().required(),
    question: Joi.string().required(),
    category: Joi.string().required(),
    criteria: Joi.string().required(),
  }),
}).required();

export const questionId = Joi.object({
  params: Joi.object({
    _id: Joi.string().required(),
  }),
}).required();

export const answers = Joi.object({
  body: Joi.object({
    answers: Joi.array()
      .items(
        // Joi.object<IAnswerQuestion>({
        Joi.object({
          questionId: Joi.string().required(),
          question: Joi.string().optional(),
          answer: Joi.string().required(),
        }).required()
      )
      .required(),
  }),
}).required();

export const allQuestions = Joi.object({
  query: Joi.object({
    limit: Joi.number(),
    offset: Joi.number(),
    sort: Joi.string().valid("asc", "desc"),
  }),
}).required();
