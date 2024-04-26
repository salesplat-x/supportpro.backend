import { IProfile, IUser } from "../../typings/user";
import * as userRepository from "../../repository/v1/user";
import * as roleRepository from "../../repository/v1/role";
import { makeResponse } from "../../helpers/response";

export const uploadProfile = async (payload: IProfile, user: IUser) => {
  let existingUser = await userRepository.findUserById(user._id);
  if (!existingUser) {
    return makeResponse(false, "Authenticated user no longer exist!", {});
  }
  if (existingUser.profile) {
    return makeResponse(false, "This user already has a profile!", {});
  }

  payload.role.forEach(async (role) => {
    const existingRole = await roleRepository.findRoleById(role as string);
    if (!existingRole) {
      return makeResponse(false, "Role does not exist", {}, 404);
    }
  });
  const profile = await userRepository.createProfile(payload);
  existingUser = await userRepository.findUserByIdAndUpdate(user._id, {
    profile: profile._id,
  });
  existingUser?.set("password", undefined);
  return makeResponse(true, "User profile added", { user: existingUser });
};

export const editProfile = async (payload: IProfile, user: IUser) => {
  let existingUser = await userRepository.findUserById(user._id);
  if (!existingUser) {
    return makeResponse(false, "Authenticated user no longer exist!", {});
  }

  await userRepository.findProfileByIdAndUpdate(user.profile, payload);

  existingUser?.set("password", undefined);
  return makeResponse(true, "User profile added", { user: existingUser });
};

export const me = async (user: IUser) => {
  let existingUser = await userRepository.findUserById(user._id);
  if (!existingUser) {
    return makeResponse(false, "Authenticated user no longer exist!", {});
  }

  existingUser.set("password", undefined);
  return makeResponse(true, "User details fetched", { user: existingUser });
};
