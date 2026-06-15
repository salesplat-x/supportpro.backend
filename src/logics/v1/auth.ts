import { IUser, IUserPasswordUpdate } from "../../typings/user";
import * as userRepository from "../../repository/v1/user";
import { makeResponse } from "../../helpers/response";
import { validateEmail } from "../../helpers/func";
import {
  compareHashedPassword,
  generateHashedPassword,
  generateOTP,
  signToken,
} from "../../helpers/utils";
import EmailService from "../../services/v1/email";
import logger from "../../config/logger";

export const createUser = async (userPayload: IUser, ip?: string) => {
  if (!validateEmail(userPayload.email)) {
    return makeResponse(false, "Invalid Email Address");
  }
  userPayload.email = userPayload.email.toLowerCase();

  let existingUser = await userRepository.findUserByEmail(userPayload.email);
  if (existingUser) {
    return makeResponse(false, "Email already in use");
  }
  if (userPayload.phone) {
    existingUser = await userRepository.findUserByMatch({
      phone: userPayload.phone,
    });
    if (existingUser) {
      return makeResponse(false, "Phone Number already in use");
    }
  }
  userPayload.password = await generateHashedPassword(userPayload.password);
  userPayload.emailVerified = true;

  const user = await userRepository.createTalentUserWithProfile(userPayload);
  if (!user) {
    return makeResponse(false, "User Registration Failed, Please Try Again");
  }

  await new EmailService().sendWelcome(user);

  logger.log(`User registered: id=${user._id} email=${user.email} ip=${ip ?? "unknown"}`);

  const token = signToken(user);
  return makeResponse(true, "User Registered Successfully", { user, token }, 201);
};

export const loginUser = async (
  { email, password }: Pick<IUser, "email" | "password">,
  ip?: string
) => {
  const user = await userRepository.findUserByEmail(email.toLocaleLowerCase());
  if (!user) {
    logger.logErrorMessage(`Failed login attempt: email=${email} ip=${ip ?? "unknown"}`);
    return makeResponse(false, "Invalid email or password", {}, 403);
  }
  if (!(await compareHashedPassword(password!, user.password))) {
    logger.logErrorMessage(
      `Failed login attempt: id=${user._id} email=${user.email} ip=${ip ?? "unknown"}`
    );
    return makeResponse(false, "Invalid email or password.", {}, 403);
  }
  if (!user.active) {
    logger.logErrorMessage(
      `Failed login attempt (deactivated account): id=${user._id} email=${user.email} ip=${ip ?? "unknown"}`
    );
    return makeResponse(false, "This account has been deactivated!", {}, 403);
  }

  logger.log(`User logged in: id=${user._id} email=${user.email} ip=${ip ?? "unknown"}`);

  const token = signToken(user);
  return makeResponse(true, "Login successful", { user, token }, 200);
};

export const forgotPassword = async ({ email }: Pick<IUser, "email">, ip?: string) => {
  const genericResponse = makeResponse(
    true,
    "If an account exists for this email, a reset code has been sent."
  );

  const user = await userRepository.findUserByMatch({ email: email.toLowerCase() });

  logger.log(`Password reset requested: email=${email.toLowerCase()} ip=${ip ?? "unknown"}`);

  if (!user) {
    return genericResponse;
  }

  const { otp, expires } = await generateOTP(5);

  user.recoveryCode = otp;
  user.recoveryCodeExpiry = expires;
  await user.save();

  await new EmailService().sendPasswordReset(user, otp);
  return genericResponse;
};

export const resetPassword = async (
  payload: { email: string; otp: string; password: string },
  ip?: string
) => {
  const { email, otp, password } = payload;

  const user = await userRepository.findUserByMatch({
    email: email.toLowerCase(),
    recoveryCode: otp,
    recoveryCodeExpiry: { $gte: Date.now() },
  });

  if (!user) {
    logger.logErrorMessage(
      `Password reset failed (invalid or expired code): email=${email.toLowerCase()} ip=${ip ?? "unknown"}`
    );
    return makeResponse(false, "Password reset token is invalid or has expired.");
  }

  user.password = await generateHashedPassword(password);
  user.recoveryCode = undefined;
  user.recoveryCodeExpiry = undefined;
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;

  await user.save();

  logger.log(`Password reset: id=${user._id} email=${user.email} ip=${ip ?? "unknown"}`);

  return makeResponse(true, "Password has been reset");
};

export const changePassword = async (_user: IUser, payload: IUserPasswordUpdate, ip?: string) => {
  const { newPassword, oldPassword } = payload;

  const user = await userRepository.findUserById(_user.id);

  if (!user) {
    return makeResponse(false, "Authenticated user not found!");
  }

  if (!(await compareHashedPassword(oldPassword!, user.password))) {
    logger.logErrorMessage(
      `Password change failed (invalid current password): id=${user._id} email=${user.email} ip=${ip ?? "unknown"}`
    );
    return makeResponse(false, "Invalid password.", {}, 403);
  }

  user.password = await generateHashedPassword(newPassword);
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;

  await user.save();

  logger.log(`Password changed: id=${user._id} email=${user.email} ip=${ip ?? "unknown"}`);

  const token = signToken(user);
  return makeResponse(true, "Password changed", { user, token }, 200);
};

export const logout = async (_user: IUser, ip?: string) => {
  const user = await userRepository.findUserAuthById(_user.id);

  if (!user) {
    return makeResponse(false, "Authenticated user not found!");
  }

  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  await user.save();

  logger.log(`User logged out: id=${user._id} email=${user.email} ip=${ip ?? "unknown"}`);

  return makeResponse(true, "Logged out successfully");
};
