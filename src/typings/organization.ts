import { Types } from "mongoose";

export interface IOrganization {
  _id: Types.ObjectId | string;
  email: string;
  name: string;
  phone: string;
  size: number;
  logo: string;
  website: string;
  address: string;
  industry: string;
  twitter: string;
  linkedin: string;
  facebook: string;
  __v: number;
}
