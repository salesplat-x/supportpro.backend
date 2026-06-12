import bcrypt from "bcrypt";
import crypto from "crypto";
import { IUser } from "../typings/user";
import { MakeResponse } from "../typings/customs";
import jwt from "jsonwebtoken";
import { makeResponse } from "./response";
import mongoose from "mongoose";
import env from "../config/env";

export const generateHashedPassword = async (password: string) => {
  const salt = await bcrypt.genSalt(env.salt_rounds);
  return bcrypt.hash(password, salt);
};

export const compareHashedPassword = async (password: string, hashedPassword: string) => {
  return bcrypt.compare(password, hashedPassword);
};

export const signToken = (user: Pick<IUser, "_id" | "email" | "tokenVersion">): string => {
  return jwt.sign(
    {
      _id: user._id,
      email: user.email,
      tokenVersion: user.tokenVersion ?? 0,
    },
    env.jwt_secret!,
    {
      expiresIn: "1d",
      algorithm: "HS256",
    }
  );
};

export const verifyToken = async (
  token: string,
  secret: string,
  repository: (id: string | mongoose.Types.ObjectId) => Promise<IUser | null>
): Promise<MakeResponse<IUser | undefined>> => {
  if (!token) {
    return makeResponse(false, "Login required");
  }
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] }) as unknown as {
      _id: mongoose.Types.ObjectId;
      tokenVersion?: number;
    };
    const user = await repository(decoded._id);
    if (!user) {
      return makeResponse(false, "Login required", undefined, 401);
    }
    if (!user.active) {
      return makeResponse(
        false,
        "Account deactivated, contact support to reactivate",
        undefined,
        403
      );
    }
    if ((user.tokenVersion ?? 0) !== (decoded.tokenVersion ?? 0)) {
      return makeResponse(false, "Login required", undefined, 401);
    }
    return makeResponse(true, "", user);
  } catch (error) {
    return makeResponse(false, "Login required", undefined);
  }
};

// generateOTP generates a cryptographically secure random 6 digit OTP
export const generateOTP = async (expiry: number = 15): Promise<{ otp: string; expires: Date }> => {
  const expires = new Date(new Date().setMinutes(new Date().getMinutes() + expiry));
  const otp = crypto.randomInt(100000, 1000000).toString();
  return { otp, expires };
};

// generateSecurePassword generates password that contains at least one number, one letter and one special character
export const generateSecurePassword = (length: number = 8): string => {
  let password = "";
  const specialChars = "!@#$%&?=";
  for (let i = 0; i < length; i++) {
    const random = Math.floor(Math.random() * 3);
    switch (random) {
      case 0:
        password += String.fromCharCode(48 + Math.floor(Math.random() * 10));
        break;
      case 1:
        password += String.fromCharCode(65 + Math.floor(Math.random() * 26));
        break;
      case 2:
        password += specialChars.charAt(Math.floor(Math.random() * specialChars.length));
        break;
    }
  }
  return password;
};

export type AtLeastOne<T, Keys extends keyof T = keyof T> = Partial<T> &
  { [K in Keys]: Required<Pick<T, K>> }[Keys];
