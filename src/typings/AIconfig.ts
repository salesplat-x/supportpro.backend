import { Types } from "mongoose";

export interface IAIConfig {
  _id?: string | Types.ObjectId;
  name: string;
  recruiter: string | Types.ObjectId;
  organization?: string | Types.ObjectId;
  prescreeningAssessment: boolean;
  minPrescreeningScore: number;
  cvSimilarity: boolean;
  minCvSimilarityScore: number;
  noOfCvSimilarCandidates: number;
  personalizedAssessment: boolean;
  noPersonalizedQuestions: number;
  recruiterGuide: string;
  uploadedQuestions: string[];
  personalityEvaluation: boolean;
}
