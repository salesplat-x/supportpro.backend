import { Types } from "mongoose";
import { IRole } from "./role";

export interface IJob {
  _id: Types.ObjectId;
  role: string | Types.ObjectId | IRole;
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
