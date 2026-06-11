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
  userPayload.password = generateHashedPassword(userPayload.password);
  const { otp, expires } = await generateOTP();

  userPayload.verificationCode = otp;
  userPayload.verificationCodeExpiry = expires;

  const user = await userRepository.createUser(userPayload);
  if (!user) {
    return makeResponse(false, "User Registration Failed, Please Try Again");
  }

  await new Email().sendOtp(user, otp);

  const token = signToken(user);
  return makeResponse(true, "User Registered Successfully", { user, token }, 201);
};

export const resendOtp = async (payload: { email: string }) => {
  const user = await userRepository.findUserByMatch({
    email: payload.email.toLowerCase(),
  });

  if (!user) {
    return makeResponse(false, "User not found!", undefined, 404);
  }

  if (user.emailVerified) {
    return makeResponse(false, "User already verified!");
  }

  const { otp, expires } = await generateOTP();
  await new Email().sendOtp(user, otp);

  user.verificationCode = otp;
  user.verificationCodeExpiry = expires;
  await user.save();

  return makeResponse(true, "OTP sent.", {
    user,
  });
};

export const verifyEmail = async (payload: { email: string; otp: string }) => {
  const user = await userRepository.findUserByMatch({
    email: payload.email.toLowerCase(),
    verificationCode: payload.otp,
    verificationCodeExpiry: { $gte: Date.now() },
  });

  if (!user) {
    return makeResponse(false, "Invalid or expired OTP!");
  }

  user.emailVerified = true;
  user.verificationCode = undefined;
  user.verificationCodeExpiry = undefined;
  await user.save();

  await new Email().sendWelcome(user);

  return makeResponse(true, "User verified.", {
    user,
  });
};

export const loginUser = async ({ email, password }: Pick<IUser, "email" | "password">) => {
  const user = await userRepository.findUserByEmail(email.toLocaleLowerCase());
  if (!user) {
    return makeResponse(false, "Invalid email or password", {}, 403);
  }
  if (!compareHashedPassword(password!, user.password)) {
    return makeResponse(false, "Invalid email or password.", {}, 403);
  }
  if (!user.active) {
    return makeResponse(false, "This account has been deactivated!", {}, 403);
  }

  const token = signToken(user);
  return makeResponse(true, "Login successful", { user, token }, 200);
};

export const forgotPassword = async ({ email }: Pick<IUser, "email">) => {
  const user = await userRepository.findUserByMatch({ email });

  if (!user) {
    return makeResponse(false, "User not found!", {}, 404);
  }

  const { otp, expires } = await generateOTP(5);

  user.recoveryCode = otp;
  user.recoveryCodeExpiry = expires;
  await user.save();

  await new Email().sendPasswordReset(user, otp);
  return makeResponse(true, "Reset code sent");
};

export const resetPassword = async (payload: { email: string; otp: string; password: string }) => {
  const { email, otp, password } = payload;

  const user = await userRepository.findUserByMatch({
    email,
    recoveryCode: otp,
    recoveryCodeExpiry: { $gte: Date.now() },
  });

  if (!user) {
    return makeResponse(false, "Password reset token is invalid or has expired.");
  }

  user.password = generateHashedPassword(password);
  user.recoveryCode = undefined;
  user.recoveryCodeExpiry = undefined;

  await user.save();

  return makeResponse(true, "Password has been reset");
};

export const changePassword = async (_user: IUser, payload: IUserPasswordUpdate) => {
  const { newPassword, oldPassword } = payload;

  const user = await userRepository.findUserById(_user.id);

  if (!user) {
    return makeResponse(false, "Authenticated user not found!");
  }

  if (!compareHashedPassword(oldPassword!, user.password)) {
    return makeResponse(false, "Invalid password.", {}, 403);
  }

  user.password = generateHashedPassword(newPassword);

  await user.save();

  const token = signToken(user);
  return makeResponse(true, "Password changed", { user, token }, 200);
};
