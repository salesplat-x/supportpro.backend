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
import Email from "../../services/v1/email";

export const createUser = async (userPayload: IUser) => {
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

  const user = await userRepository.createUser(userPayload);
  if (!user) {
    return makeResponse(false, "User Registration Failed, Please Try Again");
  }

  await new Email().sendWelcome(user);

  const token = signToken(user);
  return makeResponse(true, "User Registered Successfully", { user, token }, 201);
};

export const loginUser = async ({ email, password }: Pick<IUser, "email" | "password">) => {
  const user = await userRepository.findUserByEmail(email.toLocaleLowerCase());
  if (!user) {
    return makeResponse(false, "Invalid email or password", {}, 403);
  }
  if (!(await compareHashedPassword(password!, user.password))) {
    return makeResponse(false, "Invalid email or password.", {}, 403);
  }
  if (!user.active) {
    return makeResponse(false, "This account has been deactivated!", {}, 403);
  }

  const token = signToken(user);
  return makeResponse(true, "Login successful", { user, token }, 200);
};

export const forgotPassword = async ({ email }: Pick<IUser, "email">) => {
  const genericResponse = makeResponse(
    true,
    "If an account exists for this email, a reset code has been sent."
  );

  const user = await userRepository.findUserByMatch({ email: email.toLowerCase() });

  if (!user) {
    return genericResponse;
  }

  const { otp, expires } = await generateOTP(5);

  user.recoveryCode = otp;
  user.recoveryCodeExpiry = expires;
  await user.save();

  await new Email().sendPasswordReset(user, otp);
  return genericResponse;
};

export const resetPassword = async (payload: { email: string; otp: string; password: string }) => {
  const { email, otp, password } = payload;

  const user = await userRepository.findUserByMatch({
    email: email.toLowerCase(),
    recoveryCode: otp,
    recoveryCodeExpiry: { $gte: Date.now() },
  });

  if (!user) {
    return makeResponse(false, "Password reset token is invalid or has expired.");
  }

  user.password = await generateHashedPassword(password);
  user.recoveryCode = undefined;
  user.recoveryCodeExpiry = undefined;
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;

  await user.save();

  return makeResponse(true, "Password has been reset");
};

export const changePassword = async (_user: IUser, payload: IUserPasswordUpdate) => {
  const { newPassword, oldPassword } = payload;

  const user = await userRepository.findUserById(_user.id);

  if (!user) {
    return makeResponse(false, "Authenticated user not found!");
  }

  if (!(await compareHashedPassword(oldPassword!, user.password))) {
    return makeResponse(false, "Invalid password.", {}, 403);
  }

  user.password = await generateHashedPassword(newPassword);
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;

  await user.save();

  const token = signToken(user);
  return makeResponse(true, "Password changed", { user, token }, 200);
};
