import Joi from "joi";
import { Experience } from "../../../typings/customs";
import { IQuestion } from "../../../typings/question";

export const question = Joi.object({
  body: Joi.object<IQuestion>({
    role: Joi.string().required(),
    question: Joi.string().required(),
    category: Joi.string().required(),
  }),
}).required();

export const questionId = Joi.object({
  params: Joi.object({
    _id: Joi.string().required(),
  }),
}).required();
