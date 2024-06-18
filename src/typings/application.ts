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
}

export const ApplicationType = {
  Invitation: "by invitation",
  Application: "by application",
} as const;

type TApplicationType = (typeof ApplicationType)[keyof typeof ApplicationType];

export const ApplicationStatus = {
  Pending: "pending",
  Accepted: "accepted",
  Rejected: "rejected",
} as const;

type TApplicationStatus =
  (typeof ApplicationStatus)[keyof typeof ApplicationStatus];
