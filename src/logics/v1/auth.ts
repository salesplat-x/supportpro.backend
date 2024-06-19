import { IUser } from "../../typings/user";
import * as organizationRepository from "../../repository/v1/organization";
import * as userRepository from "../../repository/v1/user";
import { makeResponse } from "../../helpers/response";
import { validateEmail } from "../../helpers/func";
import {
  compareHashedPassword,
  generateHashedPassword,
  signToken,
} from "../../helpers/utils";
import { IOrganization } from "../../typings/organization";

export const createUser = async (userPayload: IUser) => {
  if (!validateEmail(userPayload.email)) {
    return makeResponse(false, "Invalid Email Address");
  }
  userPayload.email = userPayload.email!.toLowerCase();

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
  const user = await userRepository.createUser(userPayload);
  if (!user) {
    return makeResponse(false, "User Registration Failed, Please Try Again");
  }

  user.set("password", undefined);
  const token = signToken(user);
  return makeResponse(
    true,
    "User Registered Successfully",
    { user, token },
    201
  );
};

export const createOrganization = async (payload: IOrganization) => {
  let { email, phone } = payload;

  if (!validateEmail(email)) {
    return makeResponse(false, "Invalid Email Address");
  }
  email = email!.toLowerCase();

  let exists = await organizationRepository.findOrganizationByEmail(email);
  if (exists) {
    return makeResponse(
      false,
      "Organization already registered with this email"
    );
  }

  exists = await organizationRepository.findOrganizationByMatch({ phone });
  if (exists) {
    return makeResponse(
      false,
      "Organization already registered with this phone number"
    );
  }

  const organization = await organizationRepository.createOrganization(payload);
  if (!organization) {
    return makeResponse(
      false,
      "Organization registration Failed, Please Try Again"
    );
  }

  return makeResponse(
    true,
    "Organization registered Successfully",
    { organization },
    201
  );
};

export const loginUser = async ({
  email,
  password,
}: Pick<IUser, "email" | "password">) => {
  let user = await userRepository.findUserByEmail(email.toLocaleLowerCase());
  if (!user) {
    return makeResponse(false, "Invalid email or password", {}, 403);
  }
  if (!compareHashedPassword(password!, user.password)) {
    return makeResponse(false, "Invalid email or password.", {}, 403);
  }
  if (!user.active) {
    return makeResponse(false, "This account has been deactivated!", {}, 403);
  }
  user.set("password", undefined);
  const token = signToken(user);
  return makeResponse(true, "Login successful", { user, token }, 200);
};
