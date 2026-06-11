import { Document, Types } from "mongoose";
import { IRole } from "./role";
import { IUser } from "./user";
import { IJob } from "./job";
import { Paging } from "./customs";

export interface IApplication extends Document {
  _id: unknown;
  job: string | Types.ObjectId | IJob;
  role?: string | Types.ObjectId | IRole;
  talent: string | Types.ObjectId | IUser;
  recruiter: string | Types.ObjectId | IUser;
  applicationType: TApplicationType;
  personalizedQuestions?: Types.ObjectId[];
  personalizedScore?: number;
  cvSimilarityScore?: number;
  rank?: number;
  averageScore?: number;
  mbtiType?: string;
  status: TApplicationStatus;
  currentStage: TScreeningStage;
  stages: Map<TScreeningStage, TScreeningStage>;
  assessmentRetryDate?: Date;
  canTakeAssessment: () => boolean;
  setAssessmentRetryDate: (days?: number) => void;
}

export const ApplicationType = {
  Invitation: "by invitation",
  Application: "by application",
} as const;

export type TApplicationType = (typeof ApplicationType)[keyof typeof ApplicationType];

export const ScreeningStage = {
  Prescreening: "prescreening",
  CvSimilarity: "cv_similarity",
  Personalized: "personalized",
  Personality: "personality",
  Completed: "completed",
} as const;

export type TScreeningStage = (typeof ScreeningStage)[keyof typeof ScreeningStage];

export const ApplicationStatus = {
  Pending: "pending",
  RetakeAssessment: "retake_assessment",
  NotProceeding: "not_proceeding",
  Shortlisted: "shortlisted",
  Rejected: "rejected",
} as const;

export type TApplicationStatus = (typeof ApplicationStatus)[keyof typeof ApplicationStatus];

export interface FetchApplications extends Paging {
  applicationType?: string;
  applicationStatus?: string;
}
export interface IApplicationCompilation extends Paging {
  job?: string;
  applicationType?: TApplicationType;
}
