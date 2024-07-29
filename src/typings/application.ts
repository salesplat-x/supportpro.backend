import { Types } from "mongoose";
import { IRole } from "./role";
import { IUser } from "./user";
import { IJob } from "./job";

export interface IApplication {
  _id: Types.ObjectId;
  job: string | Types.ObjectId | IJob;
  role?: string | Types.ObjectId | IRole;
  talent: string | Types.ObjectId | IUser;
  applicationType: TApplicationType;
  personalizedQuestions?: Types.ObjectId[];
  personalizedScore?: number;
  cvSimilarityScore?: number;
  mbtiType?: string;
  status: TApplicationStatus;
  currentStage: TScreeningStage;
}

export const ApplicationType = {
  Invitation: "by invitation",
  Application: "by application",
} as const;

type TApplicationType = (typeof ApplicationType)[keyof typeof ApplicationType];

export const ScreeningStage = {
  Prescreening: "prescreening",
  CvSimilarity: "cv_similarity",
  Personalized: "personalized",
  Personality: "personality",
  Completed: "completed",
} as const;

export type TScreeningStage =
  (typeof ScreeningStage)[keyof typeof ScreeningStage];

export const ApplicationStatus = {
  Pending: "pending",
  RetakeAssessment: "retake_assessment",
  NotProceeding: "not_proceeding",
  Shortlisted: "shortlisted",

  Accepted: "accepted",
  Rejected: "rejected",
} as const;

type TApplicationStatus =
  (typeof ApplicationStatus)[keyof typeof ApplicationStatus];
