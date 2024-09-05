import { Document, Types } from "mongoose";
import { IRole } from "./role";
import { Paging } from "./customs";
import { IUser } from "./user";

export interface IScoutJob {
  _id: Types.ObjectId;
  companyName: string;
  role: string | Types.ObjectId | IRole;
  postedBy: string | Types.ObjectId | IUser;
  description: string;
  recruiterGuide: string;
}

export interface FetchScoutJobs extends Paging {
  postedBy?: string;
  city?: string;
  state?: string;
  country?: string;
  remote?: string;
  experienceLevel?: string;
  roleId?: string;
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
