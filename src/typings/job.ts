import { Types } from "mongoose";
import { IRole } from "./role";
import { ILocation, Paging } from "./customs";
import { IUser } from "./user";
import { TExperienceLevel } from "./customs";
import { IAIConfig } from "./AIconfig";

/**
 * @openapi
 * components:
 *   schemas:
 *     IJob:
 *       type: object
 *       required:
 *         - role
 *         - jobBrief
 *         - experienceLevel
 *         - maxSalary
 *         - minSalary
 *       properties:
 *         _id:
 *           type: string
 *           description: The unique identifier for a job.
 *         role:
 *           type: string
 *           description: The role for the job. Can be a name or an ID.
 *         postedBy:
 *           $ref: '#/components/schemas/IUser'
 *         aiConfig:
 *           type: string
 *           description: The ID of the AI configuration for this job.
 *         jobBrief:
 *           type: string
 *           description: A brief description of the job.
 *         maxSalary:
 *           type: number
 *           description: The maximum salary for the job.
 *         minSalary:
 *           type: number
 *           description: The minimum salary for the job.
 *         experienceLevel:
 *           type: string
 *           enum: ["1-3 years", "4-6 years", "7-10 years", "11-15 years", "16 years and above"]
 *         location:
 *           type: object
 *           properties:
 *             city:
 *               type: string
 *             state:
 *               type: string
 *             country:
 *               type: string
 *         workMode:
 *           type: string
 *           enum: [remote, onSite, hybrid]
 *         status:
 *           type: string
 *           enum: [active, suspended, closed]
 *           default: active
 *         requirements:
 *           type: string
 *           description: The requirements for the job.
 *         skills:
 *           type: array
 *           items:
 *             type: string
 *         goals:
 *           type: array
 *           items:
 *             type: string
 *         noOfApplicants:
 *           type: number
 *           default: 0
 */
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
