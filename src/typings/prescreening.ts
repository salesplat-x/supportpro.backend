import { Document, Types } from "mongoose";
import { IUser } from "./user";

export type TPreScreeningStatus = "pending" | "completed";

export type TQuestionCategory =
  | "professional_competency"
  | "practical_problem_solving"
  | "communication"
  | "behavioral"
  | "cultural"
  | "leadership"
  | "emotional_intelligence";

export interface IGeneratedQuestion {
  questionId: string;
  question: string;
  category: TQuestionCategory;
  options: string[];
  correctOption: number;
  intent: string;
  scoringHint?: string;
}

export interface IPreScreeningAnswer {
  questionId: string;
  selectedOption: number;
}

export interface IPreScreening extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId | IUser;
  roles: string[];
  questions: IGeneratedQuestion[];
  score: number | null;
  status: TPreScreeningStatus;
  attemptCount: number;
  maxAttempts: number;
  generatedAt: Date;
  completedAt?: Date;
  metadata?: Record<string, unknown>;
}
