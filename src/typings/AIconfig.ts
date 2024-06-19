import { Types } from "mongoose";

export interface IAIConfig {
  recruiter?: string | Types.ObjectId;
  organization?: string | Types.ObjectId;
  prescreeningAssessment: boolean;
  cvSimilarity: boolean;
  personalizedAssessment: boolean;
  personalityEvaluation: boolean;
  noPersonalizedQuestions: number;
  recruiterGuide: string[];
}
