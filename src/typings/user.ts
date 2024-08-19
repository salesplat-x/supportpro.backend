import { Document, Types } from "mongoose";
import { Paging, Roles } from "./customs";
import { IRole } from "./role";

export interface IUser {
  _id: Types.ObjectId | string;
  email: string;
  firstName: string;
  lastName: string;
  middleName: string;
  password: string;
  emailVerified: boolean;
  phone?: string;
  gender?: string;
  image?: string;
  country?: string;
  organization?: Types.ObjectId | string;
  userRole: string;
  profile: Types.ObjectId | string | IProfile;
  recoveryCode: string | null;
  recoveryCodeExpiry: Date | null;
  verificationCode: string | null;
  verificationCodeExpiry: Date | null;
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
  role: Types.Array<Types.ObjectId> | Types.Array<string> | Types.Array<IRole>;
  experience: string;
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
  authUserId: Types.ObjectId;
}

export interface IEmailOnlyPayload {
  email: string;
}

export interface FetchProfiles extends Paging {
  roleId?: string;
  experience?: string;
  minScore?: number;
  maxSalary?: number;
  incomplete?: string;
}

export interface FetchApplications extends Paging {
  applicationType?: string;
  applicationStatus?: string;
}
