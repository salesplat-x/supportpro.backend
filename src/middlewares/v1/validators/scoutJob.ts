import Joi from "joi";
import { IScoutJob } from "../../../typings/scoutJob";

export const scoutJob = Joi.object({
  body: Joi.object<IScoutJob>({
    role: Joi.string().required(),
    description: Joi.string().required(),
    companyName: Joi.string().required(),
    recruiterGuide: Joi.string().required(),
  }),
}).required();

export const updateScoutJob = Joi.object({
  params: Joi.object({
    _id: Joi.string().required(),
  }),
  body: Joi.object<IScoutJob>({
    role: Joi.string().required(),
    description: Joi.string().required(),
    companyName: Joi.string().required(),
    recruiterGuide: Joi.string().required(),
  }),
}).required();
