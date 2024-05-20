import { FetchProfiles, IProfile, IUser } from "../../typings/user";
import * as userRepository from "../../repository/v1/user";
import * as roleRepository from "../../repository/v1/role";
import { makeResponse } from "../../helpers/response";
import mongoose from "mongoose";
import { Roles } from "../../typings/customs";
import { Profile } from "../../models/v1/user";

export const uploadProfile = async (payload: IProfile, user: IUser) => {
  let existingUser = await userRepository.findUserById(user._id);
  if (!existingUser) {
    return makeResponse(false, "Authenticated user no longer exist!", {});
  }
  if (existingUser.profile) {
    return makeResponse(false, "This user already has a profile!", {});
  }

  for (const role of payload.role) {
    if (!mongoose.Types.ObjectId.isValid(role as string)) {
      return makeResponse(false, "Invalid role id", {}, 400);
    }
    const existingRole = await roleRepository.findRoleById(role as string);
    if (!existingRole) {
      return makeResponse(false, "Role does not exist", {}, 404);
    }
  }
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
  if (existingUser.userRole !== Roles.Talent) {
    return makeResponse(false, "User not a talent", {}, 404);
  }

  existingUser.set("password", undefined);
  return makeResponse(true, "User details fetched", { user: existingUser });
};

export const viewProfilesForRole = async (payload: FetchProfiles) => {
  let talents: IUser[] = [];

  // Create aggregation pipeline
  let pipeline: mongoose.PipelineStage[] = [
    {
      $match: {
        userRole: Roles.Talent,
      },
    },
    {
      $project: {
        password: 0, // Exclude password field from user object
      },
    },
    {
      $lookup: {
        from: "profiles",
        localField: "profile",
        foreignField: "_id",
        as: "profile",
      },
    },
  ];

  if (payload.roleId) {
    if (!mongoose.Types.ObjectId.isValid(payload.roleId)) {
      return makeResponse(false, "Invalid role id", {}, 400);
    }
    const role = await roleRepository.findRoleById(payload.roleId);
    if (!role) {
      return makeResponse(false, "Role does not exist", {}, 404);
    }
    pipeline.push({
      $match: {
        "profile.role": new mongoose.Types.ObjectId(payload.roleId),
      },
    });
  }

  if (payload.experience) {
    pipeline.push({ $match: { "profile.experience": payload.experience } });
  }
  if (payload.minScore) {
    pipeline.push({
      $match: { "profile.score": { $gte: Number(payload.minScore) } },
    });
  }
  if (payload.maxSalary) {
    pipeline.push({
      $match: { "profile.score": { $lte: Number(payload.maxSalary) } },
    });
  }
  if (payload.incomplete != "true") {
    pipeline.push({
      $match: {
        "profile.score": { $exists: true },
      },
    });
  }

  pipeline.push(
    { $unwind: "$profile" },
    {
      $lookup: {
        from: "roles",
        localField: "profile.role",
        foreignField: "_id",
        as: "profile.role",
      },
    },
    { $sort: { "profile.score": -1 } }
  );

  // Use an aggregation to get all users with the specified role
  talents = await userRepository.userAggregate(pipeline, payload);
  return makeResponse(true, "User details fetched", { talents });
};
