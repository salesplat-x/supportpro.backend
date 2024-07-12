import { Types } from "mongoose";
import { IRole } from "./role";
import { Paging } from "./customs";
import { IUser } from "./user";
import { IAIConfig } from "./AIconfig";

export interface IJob {
  _id: Types.ObjectId;
  role: string | Types.ObjectId | IRole;
  postedBy: string | Types.ObjectId | IUser;
  aiConfig: string | Types.ObjectId | IAIConfig;
  description: string;
  maxSalary: number;
  minSalary: number;
  experienceLevel: string;
  location: ILocation;
  address?: string;
  remote: boolean;
  responsibilities?: Types.Array<string>;
  skills?: Types.Array<string>;
  goals?: Types.Array<string>;
}

export interface ILocation {
  city: string;
  state: string;
  country: string;
}

export interface FetchJobs extends Paging {
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
