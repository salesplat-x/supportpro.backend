import { Types } from "mongoose";
import { IRole } from "./role";
import { IJob } from "./job";

export interface IQuestion {
  _id?: Types.ObjectId;
  role?: string | Types.ObjectId | IRole;
  job?: string | Types.ObjectId | IJob;
  type: TQuestionType;
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

export interface AnswerPersonalityPayload {
  jobId: Types.ObjectId | string;
  answers: IAnswerQuestion[];
}

export interface AnswerPersonalizedPayload {
  jobId: Types.ObjectId | string;
  answers: {
    question: string;
    answer: string;
  }[];
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
  Assessment: "assessment",
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
