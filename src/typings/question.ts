import { Types } from "mongoose";
import { IRole } from "./role";
import { IJob } from "./job";
import { Paging } from "./customs";

export interface IQuestion {
  _id?: Types.ObjectId;
  role?: string | Types.ObjectId | IRole;
  job?: string | Types.ObjectId | IJob;
  type: TQuestionType;
  question: string;
  category?: string;
  criteria?: string;
}

export interface FetchQuestions extends Paging {
  jobId?: string;
  roleId?: string;
  talentId?: string;
  questionType?: string;
}

export interface IAnswerQuestion {
  questionId: Types.ObjectId | string;
  answer: string;
}
export interface AnswerPrescreeningPayload {
  roleId: Types.ObjectId | string;
  answers: Record<string, string>;
}

export interface EvaluatePersonalityPayload {
  jobId: Types.ObjectId | string;
  answers: Record<string, string>;
}

export interface AnswerPersonalizedPayload {
  jobId: Types.ObjectId | string;
  answers: Record<string, string>;
}

export interface IQuestionConstruct {
  questionId: Types.ObjectId | string;
  question: string;
  answer: string;
  category?: string;
  criteria?: string;
  dichotomy?: string;
}

export interface IGeneratePersonalizedQuestions {
  talentId: string;
  jobId: string;
  recruiterGuide: Array<string>;
}

export interface IGeneratePersonalityQuestions {
  jobId: string;
  dichotomyPair: TDichotomyPair;
}

export const QuestionType = {
  Prescreening: "prescreening",
  Personality: "personality",
  Personalized: "personalized",
} as const;

export type TQuestionType = (typeof QuestionType)[keyof typeof QuestionType];

export const DichotomyPair = {
  EI: "EI",
  SN: "SN",
  TF: "TF",
  JP: "JP",
} as const;

export type TDichotomyPair = (typeof DichotomyPair)[keyof typeof DichotomyPair];
