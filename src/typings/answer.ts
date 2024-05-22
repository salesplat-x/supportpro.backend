import { Types } from "mongoose";
import { IUser } from "./user";
import { IRole } from "./role";

export interface IResponse {
  question: string;
  answer: string;
  score: number;
}

export interface IAnswer {
  _id: Types.ObjectId;
  user: string | Types.ObjectId | IUser;
  role: string | Types.ObjectId | IRole;
  responses: IResponse[];
}
