import { Document, Types } from "mongoose";
import { ILocation, Paging, Roles, TExperienceLevel } from "./customs";
import { IRole } from "./role";

export interface IUser extends Document {
  _id: Types.ObjectId | string;
  email: string;
  firstName: string;
  lastName: string;
  middleName: string;
  password: string;
  emailVerified: boolean;
  picture?: string;
  phone?: string;
  gender?: string;
  image?: string;
  country?: string;
  organization?: Types.ObjectId | string;
  userRole: string;
  profile: Types.ObjectId | string | IProfile;
  recoveryCode?: string;
  recoveryCodeExpiry?: Date;
  verificationCode?: string;
  verificationCodeExpiry?: Date;
  active: boolean;
  onboarded: boolean;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

export interface IProfile extends Document {
  _id: Types.ObjectId | string;
  bio: string;
  cv: string;
  remote: boolean;
  onSite: boolean;
  hybrid: boolean;
  location?: ILocation;
  role: Types.Array<Types.ObjectId> | Types.Array<string> | Types.Array<IRole>;
  experience: TExperienceLevel;
  maxSalary: number;
  minSalary: number;
  prescreeningScore: number;
  assessmentRetryDate?: Date;
  canTakeAssessment: () => boolean;
  setAssessmentRetryDate: (days?: number) => void;
}

export interface IUserPasswordUpdate {
  oldPassword: string;
  newPassword: string;
}

export interface IEmailOnlyPayload {
  email: string;
}

export interface FetchProfiles extends Paging {
  roleId?: string;
  experience?: TExperienceLevel;
  minScore?: number;
  maxSalary?: number;
  incomplete?: string;
}
