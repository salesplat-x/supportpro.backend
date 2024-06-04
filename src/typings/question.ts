import { Types } from "mongoose";
import { IRole } from "./role";

export interface IQuestion {
  _id?: Types.ObjectId;
  role: string | Types.ObjectId | IRole;
  question: string;
  category: string;
  criteria: string;
}

export interface IAnswerQuestion {
  questionId: Types.ObjectId | string;
  answer: string;
}
export interface AnswerQuestionPayload {
  roleId: Types.ObjectId | string;
  answers: IAnswerQuestion[];
}
export interface IQuestionConstruct {
  questionId: Types.ObjectId | string;
  question: string;
  answer: string;
  category?: string;
  criteria: string;
}

export interface IGenerateQuestions {
  talentId: string;
  jobId: string;
  recruiterNotes: Array<string>;
}
