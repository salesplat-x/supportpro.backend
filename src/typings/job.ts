import { Types } from "mongoose";
import { IRole } from "./role";
import { ILocation, Paging } from "./customs";
import { IUser } from "./user";
import { TExperienceLevel } from "./customs";
import { IAIConfig } from "./AIconfig";


export interface IJob {
  _id: Types.ObjectId;
  role: string | Types.ObjectId | IRole;
  postedBy: string | Types.ObjectId | IUser;
  aiConfig: string | Types.ObjectId | IAIConfig;
  jobBrief: string;
  maxSalary: number;
  minSalary: number;
  experienceLevel: TExperienceLevel;
  location: ILocation;
  //address?: string;
  workMode: TWorkMode;
  status: TJobStatus;
  requirements?: string;
  skills?: Types.Array<string>;
  goals?: Types.Array<string>;
  noOfApplicants: number;
}

export interface FetchJobs extends Paging {
  postedBy?: string;
  city?: string;
  state?: string;
  country?: string;
  workMode?: TWorkMode;
  experienceLevel?: TExperienceLevel;
  roleId?: string;
  status?: TJobStatus;
}

export interface MatchJob extends Paging {
  _id: string;
  incomplete?: string;
}

export interface TopTalents {
  jobId: string;
  percentage: number;
  limit: number;
}

export interface IFetchApplications extends Paging {
  jobId: string;
  experience: string;
  applicationType: string;
  applicationStatus: string;
  minCvSimilarityScore: number;
  minPersonalizedScore: number;
  minSalary: number;
  maxSalary: number;
}

export interface IApply {
  jobId: string | Types.ObjectId;
}

export const JobStatus = {
  Active: "active",
  Suspended: "suspended",
  Closed: "closed",
} as const;

export type TJobStatus = (typeof JobStatus)[keyof typeof JobStatus];

export const WorkMode = {
  Remote: "remote",
  OnSite: "onSite",
  Hybrid: "hybrid",
} as const;

export type TWorkMode = (typeof WorkMode)[keyof typeof WorkMode];
