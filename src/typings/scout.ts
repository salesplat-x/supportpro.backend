import { Document, Types } from "mongoose";
import { IUser } from "./user";
import { ILocation, Paging } from "./customs";

export interface IScout extends Document {
  batchId: string;
  cvName: string;
  coverLetterName?: string;
  cvText: string;
  coverLetterText?: string;
  cvScore: number;
  coverLetterScore?: number;
  evaluationScore: number;
  recruiter: Types.ObjectId | IUser | string;
}

export interface ICvAndCoverLetter {
  batchId?: string;
  files: Express.Multer.File[];
  file: Express.Multer.File;
  scoutJobId: string;
}

export interface IScoutResponse {
  cvScore?: number;
  coverLetterScore?: number;
}

export interface IScoutTalents extends ILocation, Paging {
  scoutJobId?: string;
  roleId?: string;
  experience?: string;
  //Not used
  remote?: string;
}
