import { Types } from "mongoose";
import { IRole } from "./role";
import { IUser } from "./user";
import { IJob } from "./job";

export interface IJobTalent {
  _id: Types.ObjectId;
  job: string | Types.ObjectId | IJob;
  role: string | Types.ObjectId | IRole;
  talent: string | Types.ObjectId | IUser;
  personalizedQuestions?: Types.Array<string>;
  personalizedScore?: number;
  mbtiType?: string;
}
