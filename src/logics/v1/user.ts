import { FetchProfiles, IProfile, IUser } from "../../typings/user";
import { FetchApplications } from "../../typings/application";
import * as userRepository from "../../repository/v1/user";
import * as roleRepository from "../../repository/v1/role";
import * as applicationRepository from "../../repository/v1/application";
import { makeResponse } from "../../helpers/response";
import mongoose, { HydratedDocument } from "mongoose";
import { Roles } from "../../typings/customs";

// Lazily backfills a Profile for legacy Talent users that don't have one yet.
const ensureTalentProfile = async (
  user: HydratedDocument<IUser>
): Promise<HydratedDocument<IUser>> => {
  if (user.userRole !== Roles.Talent || user.profile) {
    return user;
  }
  const profile = await userRepository.createProfile({
    role: [],
    remote: false,
    onSite: false,
    hybrid: false,
  });
  const updated = await userRepository.findUserByIdAndUpdate(user._id, {
    profile: profile._id,
  });
  return updated ?? user;
};

export const updateUser = async (_user: IUser, payload: Partial<IUser>) => {
  const user = await userRepository.findUserByIdAndUpdate(_user._id, payload);
  return makeResponse(true, "User updated successfully", { user });
};

export const editProfile = async (payload: Partial<IProfile>, _user: IUser) => {
  let existingUser = await userRepository.findUserById(_user._id);
  if (!existingUser) {
    return makeResponse(false, "Authenticated user no longer exist!", {});
  }
  existingUser = await ensureTalentProfile(existingUser);

  if (payload.role) {
    for (const role of payload.role) {
      if (!mongoose.Types.ObjectId.isValid(role as string)) {
        return makeResponse(false, "Invalid role id", {}, 400);
      }
      const existingRole = await roleRepository.findRoleById(role as string);
      if (!existingRole) {
        return makeResponse(false, "Role does not exist", {}, 404);
      }
    }
  }

  const profile = await userRepository.findProfileByIdAndUpdate(
    (existingUser.profile as IProfile)._id,
    payload
  );

  return makeResponse(true, "User profile updated successfully", { profile });
};

export const me = async (user: IUser) => {
  let existingUser = await userRepository.findUserById(user._id);
  if (!existingUser) {
    return makeResponse(false, "Authenticated user no longer exist!", {});
  }
  existingUser = await ensureTalentProfile(existingUser);

  existingUser.set("password", undefined);
  return makeResponse(true, "User details fetched", { user: existingUser });
};

export const viewProfile = async (user: Pick<IUser, "_id">) => {
  if (!mongoose.Types.ObjectId.isValid(user._id)) {
    return makeResponse(false, "Invalid user id", {}, 400);
  }
  const existingUser = await userRepository.findUserAndScoreById(user._id);
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
  // Create aggregation pipeline
  const pipeline: mongoose.PipelineStage[] = [
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
  if (!payload.incomplete) {
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
  const talents: IUser[] = await userRepository.userAggregate(pipeline, payload);
  return makeResponse(true, "User details fetched", { talents });
};

export const applications = async (user: IUser, payload: FetchApplications) => {
  const { applicationType, applicationStatus } = payload;

  const pipeline: mongoose.PipelineStage[] = [
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
        createdAt: 1,
        personalizedScore: 1,
        cvSimilarityScore: 1,
        mbtiType: 1,
        "role.name": 1,
        "role.description": 1,
        "job._id": 1,
        "job.jobBrief": 1,
        "job.maxSalary": 1,
        "job.minSalary": 1,
        "job.experienceLevel": 1,
        "job.location": 1,
        //"job.address": 1,
        "job.workMode": 1,
        "postedBy.firstName": 1,
        "postedBy.lastName": 1,
        "postedBy.email": 1,
      },
    }
  );

  const applications = await applicationRepository.applicationAggregate(pipeline);

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
