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
  recruiterGuide: Array<string>;
}

export interface IPersonalityQuestion {
  job: string | Types.ObjectId | IRole;
  dichotomyPair: TDichotomyPair;
  question: string;
}
export interface IGeneratePersonalityQuestions {
  jobId: string;
  dichotomyPair: TDichotomyPair;
}

export const DichotomyPair = {
  EI: "EI",
  SN: "SN",
  TF: "TF",
  JP: "JP",
} as const;

export type TDichotomyPair = keyof typeof DichotomyPair;
