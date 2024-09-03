import { Document, Types } from "mongoose";
import { IUser } from "./user";

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
  jobId: string;
  files: Express.Multer.File[];
  file: Express.Multer.File;
}

export interface IScoutResponse {
  cvScore?: number;
  coverLetterScore?: number;
}
