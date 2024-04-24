import { Types } from "mongoose";

export interface IRole {
  _id: Types.ObjectId;
  name: string;
  description: string;
  // questions: Types.Array<string>;  @//TODO: switch to questions table
}
