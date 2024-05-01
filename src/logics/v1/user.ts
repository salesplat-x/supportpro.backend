import { FetchProfiles, IProfile, IUser } from "../../typings/user";
import * as userRepository from "../../repository/v1/user";
import * as roleRepository from "../../repository/v1/role";
import { makeResponse } from "../../helpers/response";
import mongoose from "mongoose";
import user from "../../routes/v1/user";
import { Roles } from "../../typings/customs";

export const uploadProfile = async (payload: IProfile, user: IUser) => {
  let existingUser = await userRepository.findUserById(user._id);
  if (!existingUser) {
    return makeResponse(false, "Authenticated user no longer exist!", {});
  }
  if (existingUser.profile) {
    return makeResponse(false, "This user already has a profile!", {});
  }

  payload.role.forEach(async (role) => {
    if (!mongoose.Types.ObjectId.isValid(role as string)) {
      return makeResponse(false, "Invalid role id", {}, 400);
    }
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

  await userRepository.findProfileByIdAndUpdate(
    (user.profile as IProfile)._id,
    payload
  );

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

export const viewProfile = async (user: Pick<IUser, "_id">) => {
  if (!mongoose.Types.ObjectId.isValid(user._id)) {
    return makeResponse(false, "Invalid user id", {}, 400);
  }
  let existingUser = await userRepository.findUserAndScoreById(user._id);
  if (!existingUser) {
    return makeResponse(false, "User not found", {}, 404);
  }

  existingUser.set("password", undefined);
  return makeResponse(true, "User details fetched", { user: existingUser });
};

export const viewProfilesForRole = async (payload: FetchProfiles) => {
  let query: mongoose.RootQuerySelector<IUser> = { userRole: Roles.Talent };
  let talents: IUser[] = [];
  if (payload.roleId) {
    const match = {
      ...query,
      // "profile.role": payload.roleId,
    };
    if (!mongoose.Types.ObjectId.isValid(payload.roleId)) {
      return makeResponse(false, "Invalid role id", {}, 400);
    }
    const role = roleRepository.findRoleById(payload.roleId);
    if (!role) {
      return makeResponse(false, "Role does not exist", {}, 404);
    }
    // talents = await userRepository.userRoleAggregate(payload.roleId);
    talents = await userRepository.findUsersByMatch(match, payload);
  } else {
    talents = await userRepository.findUsersByMatch({ ...query }, payload);
  }
  return makeResponse(true, "User details fetched", { talents });
};
