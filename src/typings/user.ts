import { Document, Types } from "mongoose";
import { ILocation, Paging, Roles, TExperienceLevel, TWorkType } from "./customs";
import { TCurrency } from "./plan";
import { IRole } from "./role";
import { IPreScreening } from "./prescreening";

export interface ICvAsset {
  url: string;
  publicId?: string;
  uploadedAt: Date;
}

export interface IProfileImage {
  url: string;
  publicId?: string;
}

export interface IUser extends Document {
  _id: Types.ObjectId | string;
  email: string;
  firstName: string;
  lastName: string;
  middleName: string;
  password: string;
  emailVerified: boolean;
  profileImage?: IProfileImage;
  phone?: string;
  country?: string;
  organization?: Types.ObjectId | string;
  userRole: (typeof Roles)[keyof typeof Roles];
  profile?: Types.ObjectId | string | IProfile;
  recoveryCode?: string;
  recoveryCodeExpiry?: Date;
  tokenVersion?: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}

export interface IProfile extends Document {
  _id: Types.ObjectId | string;
  bio?: string;
  cv?: ICvAsset;
  workType?: TWorkType[] | null;
  location?: ILocation;
  role: Types.Array<Types.ObjectId> | Types.Array<string> | Types.Array<IRole>;
  experience?: TExperienceLevel;
  currency?: TCurrency;
  maxSalary?: number;
  minSalary?: number;
  prescreeningScore?: number;
  assessmentRetryDate?: Date;
  roleChangeCount?: number;
  activePreScreening?: Types.ObjectId | string | IPreScreening;
  canTakeAssessment: () => boolean;
  setAssessmentRetryDate: (days?: number) => void;
  readonly profileCompletionPercentage: number;
  readonly isProfileComplete: boolean;
  readonly canProceedToPlatform: boolean;
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
  incomplete?: boolean;
}
