import bcrypt from "bcrypt";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import authConfig from "../config/auth.js";
import { UserRole } from "../types/enums.js";
import type { User } from "../entities";

export const generateHashedPassword = async (password: string): Promise<string> => {
  const salt = await bcrypt.genSalt(authConfig.saltRounds);
  return bcrypt.hash(password, salt);
};

export const compareHashedPassword = async (
  password: string,
  hashedPassword: string
): Promise<boolean> => {
  return bcrypt.compare(password, hashedPassword);
};

export const signToken = (
  user: Pick<User, "id" | "email" | "tokenVersion" | "userRole">
): string => {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      tokenVersion: user.tokenVersion ?? 0,
      userRole: user.userRole,
    },
    authConfig.jwtSecret,
    { expiresIn: authConfig.tokenExpiresIn, algorithm: "HS256" }
  );
};

export interface JwtPayload {
  id: string;
  email: string;
  tokenVersion: number;
  userRole: UserRole;
}

export const decodeToken = (token: string): JwtPayload => {
  return jwt.verify(token, authConfig.jwtSecret, { algorithms: ["HS256"] }) as JwtPayload;
};

export const generateOTP = async (expiry = 15): Promise<{ otp: string; expires: Date }> => {
  const expires = new Date(new Date().setMinutes(new Date().getMinutes() + expiry));
  const otp = crypto.randomInt(100000, 1000000).toString();
  return { otp, expires };
};

export const generateSecurePassword = (length = 8): string => {
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

export const generateReference = async (
  isDuplicate: (ref: string) => Promise<boolean>,
  length = 12
): Promise<string> => {
  const randomBytes = crypto
    .randomBytes(Math.ceil(length / 2))
    .toString("hex")
    .slice(0, length);
  const timestamp = Date.now().toString(36);
  const reference = `Aux-${timestamp}${randomBytes}`.toUpperCase();
  if (await isDuplicate(reference)) {
    return generateReference(isDuplicate, length);
  }
  return reference;
};
