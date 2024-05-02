import { Types } from "mongoose";
import { IRole } from "./role";

export interface IQuestion {
  _id?: Types.ObjectId;
  role: string | Types.ObjectId | IRole;
  question: string;
  category: string;
}

export interface IAnswerQuestion {
  questionId: Types.ObjectId | string;
  answer: string;
}
export interface AnswerQuestionPayload {
  answers: IAnswerQuestion[];
}
