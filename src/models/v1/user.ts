import { Schema, model } from "mongoose";
import * as func from "../../helpers/func";
import { Roles } from "../../typings/customs";
import { IProfile, IUser } from "../../typings/user";

const userSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      unique: true,
      required: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
    },
    firstName: {
      type: String,
      required: true,
      set: func.firstCharToUpperCase,
    },
    lastName: {
      type: String,
      required: true,
      set: func.firstCharToUpperCase,
    },
    middleName: {
      type: String,
      required: false,
      set: func.firstCharToUpperCase,
    },
    picture: {
      type: String,
    },
    userRole: {
      type: String,
      enum: Roles,
      default: Roles.Talent,
    },
    phone: {
      type: String,
      required: false,
    },
    country: {
      type: String,
      required: false,
    },
    profile: {
      type: Schema.Types.ObjectId,
      ref: "profile",
      required: false,
    },
    organization: {
      type: Schema.Types.ObjectId,
      ref: "organization",
      required: false,
    },
    emailVerified: {
      type: Boolean,
      default: true,
    },
    active: {
      type: Boolean,
      default: true,
    },
    onboarded: {
      type: Boolean,
      default: false,
    },
    recoveryCode: String,
    recoveryCodeExpiry: Date,
    tokenVersion: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: function (doc, ret) {
        delete ret.__v;
        delete ret.password;
        delete ret.recoveryCode;
        delete ret.recoveryCodeExpiry;
      },
    },
  }
);

const profileSchema = new Schema<IProfile>({
  bio: {
    type: String,
    required: true,
  },
  cv: {
    type: String,
    required: true,
  },
  remote: { type: Boolean, default: false },
  onSite: { type: Boolean, default: false },
  hybrid: { type: Boolean, default: false },
  location: {
    city: { type: String, required: false },
    state: String,
    country: String,
  },
  role: [
    {
      type: Schema.Types.ObjectId,
      ref: "role",
    },
  ],
  experience: {
    type: String,
    required: true,
  },
  maxSalary: {
    type: Number,
    required: true,
  },
  minSalary: {
    type: Number,
    required: true,
  },
  prescreeningScore: {
    type: Number,
    // select: false,
  },
  assessmentRetryDate: Date,
});

// Instance method to check if the candidate can retake the assessment
profileSchema.methods.canTakeAssessment = function (): boolean {
  // If no assessmentRetryDate is set, the candidate can retake the assessment
  if (!this.assessmentRetryDate) {
    return true;
  }

  const currentDate = new Date();
  // Check if the current date is after the retry date
  return currentDate >= this.assessmentRetryDate;
};

// Instance method to set the assessmentRetryDate to one week from now
profileSchema.methods.setAssessmentRetryDate = function (days = 7): void {
  const currentDate = new Date();
  this.assessmentRetryDate = new Date(currentDate.setDate(currentDate.getDate() + days));
};

export const User = model<IUser>("user", userSchema);
export const Profile = model<IProfile>("profile", profileSchema);
