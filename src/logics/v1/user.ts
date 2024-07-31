import {
  FetchApplications,
  FetchProfiles,
  IProfile,
  IUser,
} from "../../typings/user";
import * as userRepository from "../../repository/v1/user";
import * as roleRepository from "../../repository/v1/role";
import * as applicationRepository from "../../repository/v1/application";
import { makeResponse } from "../../helpers/response";
import mongoose from "mongoose";
import { Roles } from "../../typings/customs";

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
      $match: {
        "profile.prescreeningScore": { $gte: Number(payload.minScore) },
      },
    });
  }
  if (payload.maxSalary) {
    pipeline.push({
      $match: { "profile.maxSalary": { $lte: Number(payload.maxSalary) } },
    });
  }
  if (payload.incomplete != "true") {
    pipeline.push({
      $match: {
        "profile.prescreeningScore": { $exists: true },
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
    { $sort: { "profile.prescreeningScore": -1 } }
  );

  // Use an aggregation to get all users with the specified role
  talents = await userRepository.userAggregate(pipeline, payload);
  return makeResponse(true, "User details fetched", { talents });
};

export const applications = async (user: IUser, payload: FetchApplications) => {
  const { applicationType, applicationStatus } = payload;

  const query: Record<string, any> = { talent: user._id };

  let pipeline: mongoose.PipelineStage[] = [
    { $match: { talent: new mongoose.Types.ObjectId(user._id) } },
  ];

  if (applicationType) {
    pipeline.push({ $match: { applicationType } });
  }
  if (applicationStatus) {
    pipeline.push({ $match: { status: applicationStatus } });
  }

  pipeline.push(
    {
      $lookup: {
        from: "jobs",
        localField: "job",
        foreignField: "_id",
        as: "job",
      },
    },
    { $unwind: "$job" },
    {
      $lookup: {
        from: "users",
        localField: "job.postedBy",
        foreignField: "_id",
        as: "postedBy",
      },
    },
    { $unwind: "$postedBy" },
    {
      $lookup: {
        from: "roles",
        localField: "job.role",
        foreignField: "_id",
        as: "role",
      },
    },
    { $unwind: "$role" },
    {
      $project: {
        _id: 1,
        applicationType: 1,
        status: 1,
        currentStage: 1,
        personalizedQuestions: 1,
        personalizedScore: 1,
        cvSimilarityScore: 1,
        mbtiType: 1,
        "role.name": 1,
        "role.description": 1,
        "job.description": 1,
        "job.maxSalary": 1,
        "job.minSalary": 1,
        "job.experienceLevel": 1,
        "job.location": 1,
        "job.address": 1,
        "job.remote": 1,
        "postedBy.firstName": 1,
        "postedBy.lastName": 1,
        "postedBy.email": 1,
      },
    }
  );

  const applications = await applicationRepository.applicationAggregate(
    pipeline
  );

  return makeResponse(true, "User's job applications fetched", { applications });
};

// export const applications = async (user: IUser, payload: FetchApplications) => {
//   const { applicationType, applicationStatus } = payload;

//   const query: Record<string, any> = { talent: user._id };
//   if (applicationType) {
//     query.applicationType = applicationType;
//   }
//   if (applicationStatus) {
//     query.status = applicationStatus;
//   }

//   const applications = await applicationRepository.findApplicationsByMatch(
//     query
//   );

//   return makeResponse(true, "User's job applications fetched", { applications });
// };
