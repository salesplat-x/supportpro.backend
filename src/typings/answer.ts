import { Types } from "mongoose";
import { IQuestion } from "./question";
import { IUser } from "./user";

export interface IAnswer {
  _id: Types.ObjectId;
  question: string | Types.ObjectId | IQuestion;
  user: string | Types.ObjectId | IUser;
  answer: string;
  score?: number;
  weight?: number;
}
