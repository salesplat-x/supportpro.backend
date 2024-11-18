import { Types } from "mongoose";
import { IUser } from "./user";
import { IRole } from "./role";
import { IJob } from "./job";
import { IQuestion, TQuestionType } from "./question";

export interface IResponse {
  question: string | Types.ObjectId | IQuestion;
  answer: string;
  score?: number;
  dichotomyPreference?: string;
}

export interface IAnswer {
  _id: Types.ObjectId;
  user: string | Types.ObjectId | IUser;
  job: string | Types.ObjectId | IJob;
  role: string | Types.ObjectId | IRole;
  questionType: TQuestionType;
  responses: IResponse[];
}
