import { Schema, model } from "mongoose";
import * as func from "../../helpers/func";
import { Roles } from "../../typings/customs";
import { IProfile, IUser } from "../../typings/user";

const userSchema = new Schema<IUser>(
  {
    email: {
      type: String,
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
    userRole: {
      type: String,
      enum: Roles,
      default: Roles.Talent,
    },
    phone: {
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
      default: false,
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
    verificationCode: String,
    verificationCodeExpiry: Date,
  },
  {
    timestamps: true,
    toJSON: {
      transform: function (doc, ret) {
        delete ret.password;
        delete ret.recoveryCode;
        delete ret.verificationCode;
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
});

export const User = model<IUser>("user", userSchema);
export const Profile = model<IProfile>("profile", profileSchema);
