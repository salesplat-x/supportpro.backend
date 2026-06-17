import { FetchProfiles, IProfile, IUser } from "../../typings/user";
import { FetchApplications } from "../../typings/application";
import * as userRepository from "../../repository/v1/user";
import * as roleRepository from "../../repository/v1/role";
import * as applicationRepository from "../../repository/v1/application";
import { makeResponse } from "../../helpers/response";
import mongoose, { HydratedDocument } from "mongoose";
import { MakeResponse, Roles } from "../../typings/customs";
import { destroyAsset, extractPublicIdFromUrl, replaceAsset } from "../../services/v1/cloudinary";
import { extractText, overlapChunkText, preprocessText } from "../../helpers/func";
import { createEmbedding } from "../../services/v1/openai";
import { saveTalentEmbedding } from "../../repository/v1/pg";
import { ALLOWED_CV_TYPES, CLOUDINARY_FOLDERS, CV_EXT_BY_MIME } from "../../helpers/uploads";

// Lazily backfills a Profile for legacy Talent users that don't have one yet.
const ensureTalentProfile = async (
  user: HydratedDocument<IUser>
): Promise<HydratedDocument<IUser>> => {
  if (user.userRole !== Roles.Talent || user.profile) {
    return user;
  }
  const profile = await userRepository.createProfile({ role: [] });
  const updated = await userRepository.findUserByIdAndUpdate(user._id, {
    profile: profile._id,
  });
  return updated ?? user;
};

const ROLE_CHANGE_LIMIT = 3;

// Returns true when the incoming role selection differs from the currently persisted one.
const rolesChanged = (
  existingRoles: IProfile["role"],
  incomingRoles: IProfile["role"]
): boolean => {
  const toId = (r: any): string => (r?._id ?? r).toString();
  const existing = [...existingRoles].map(toId).sort();
  const incoming = [...incomingRoles].map(toId).sort();
  return JSON.stringify(existing) !== JSON.stringify(incoming);
};

// Validates that every id in a profile's role list refers to an existing role.
const validateProfileRoles = async (roles: IProfile["role"]): Promise<MakeResponse | null> => {
  for (const role of roles) {
    if (!mongoose.Types.ObjectId.isValid(role as string)) {
      return makeResponse(false, "Invalid role id", {}, 400);
    }
    const existingRole = await roleRepository.findRoleById(role as string);
    if (!existingRole) {
      return makeResponse(false, "Role does not exist", {}, 404);
    }
  }
  return null;
};

export const updateUser = async (
  _user: IUser,
  payload: Partial<IUser> & {
    picture?: string;
    cv?: string;
    bio?: string;
    role?: IProfile["role"];
    location?: IProfile["location"];
    experience?: IProfile["experience"];
    minSalary?: number;
    maxSalary?: number;
    currency?: IProfile["currency"];
    workType?: IProfile["workType"];
  }
) => {
  const {
    picture,
    cv,
    bio,
    role,
    location,
    experience,
    minSalary,
    maxSalary,
    currency,
    workType,
    ...rest
  } = payload;
  const update: Partial<IUser> = { ...rest };

  const profileUpdate: Partial<IProfile> = {};
  if (bio !== undefined) profileUpdate.bio = bio;
  if (role !== undefined) profileUpdate.role = role;
  if (location !== undefined) profileUpdate.location = location;
  if (experience !== undefined) profileUpdate.experience = experience;
  if (minSalary !== undefined) profileUpdate.minSalary = minSalary;
  if (maxSalary !== undefined) profileUpdate.maxSalary = maxSalary;
  if (currency !== undefined) profileUpdate.currency = currency;
  if (workType !== undefined) profileUpdate.workType = workType;

  const hasProfileFields = Object.keys(profileUpdate).length > 0;

  let existingUser: HydratedDocument<IUser> | null = null;
  if (picture || cv || hasProfileFields) {
    existingUser = await userRepository.findUserById(_user._id);
    if (!existingUser) {
      return makeResponse(false, "Authenticated user no longer exist!", {});
    }
  }

  let oldImagePublicId: string | undefined;
  if (picture) {
    oldImagePublicId = existingUser?.profileImage?.publicId;
    update.profileImage = { url: picture, publicId: extractPublicIdFromUrl(picture) };
  }

  let oldCvPublicId: string | undefined;
  let newCvPublicId: string | undefined;

  if (existingUser && (cv || hasProfileFields)) {
    existingUser = await ensureTalentProfile(existingUser);
    const existingProfile = existingUser.profile as IProfile | undefined;
    if (!existingProfile) {
      return makeResponse(false, "User has no profile to update", {}, 400);
    }

    if (cv) {
      oldCvPublicId = existingProfile.cv?.publicId;
      newCvPublicId = extractPublicIdFromUrl(cv);
      profileUpdate.cv = { url: cv, publicId: newCvPublicId, uploadedAt: new Date() };
    }

    if (profileUpdate.role) {
      const roleError = await validateProfileRoles(profileUpdate.role);
      if (roleError) {
        return roleError;
      }
      if (rolesChanged(existingProfile.role, profileUpdate.role)) {
        const currentCount = existingProfile.roleChangeCount ?? 0;
        if (currentCount >= ROLE_CHANGE_LIMIT) {
          return makeResponse(
            false,
            "Role change limit reached. You may only change your role 3 times.",
            {},
            422
          );
        }
        profileUpdate.roleChangeCount = currentCount + 1;
      }
    }

    await userRepository.findProfileByIdAndUpdate(existingProfile._id, profileUpdate);
  }

  const user = await userRepository.findUserByIdAndUpdate(_user._id, update);

  if (oldImagePublicId && oldImagePublicId !== update.profileImage?.publicId) {
    await destroyAsset(oldImagePublicId, "image");
  }

  if (oldCvPublicId && oldCvPublicId !== newCvPublicId) {
    await destroyAsset(oldCvPublicId, "auto");
  }

  return makeResponse(true, "User updated successfully", { user });
};

export const editProfile = async (
  payload: Partial<IProfile>,
  _user: IUser,
  file?: Express.Multer.File
) => {
  let existingUser = await userRepository.findUserById(_user._id);
  if (!existingUser) {
    return makeResponse(false, "Authenticated user no longer exist!", {});
  }
  existingUser = await ensureTalentProfile(existingUser);

  const existingProfile = existingUser.profile as IProfile;
  const update: Partial<IProfile> = { ...payload };

  if (payload.role) {
    const roleError = await validateProfileRoles(payload.role);
    if (roleError) {
      return roleError;
    }
    if (rolesChanged(existingProfile.role, payload.role)) {
      const currentCount = existingProfile.roleChangeCount ?? 0;
      if (currentCount >= ROLE_CHANGE_LIMIT) {
        return makeResponse(
          false,
          "Role change limit reached. You may only change your role 3 times.",
          {},
          422
        );
      }
      update.roleChangeCount = currentCount + 1;
    }
  }

  if (file) {
    if (!ALLOWED_CV_TYPES.includes(file.mimetype)) {
      return makeResponse(false, "Unsupported CV file type", {}, 400);
    }

    let text: string | string[] = await extractText(file.buffer, file.mimetype);
    if (!text) {
      return makeResponse(false, "Unable to extract text from CV", {}, 400);
    }
    text = overlapChunkText(preprocessText(text));

    const cvEmbedding = await createEmbedding(text);
    const embeddingRes = await saveTalentEmbedding(_user._id.toString(), text, cvEmbedding);
    if (!embeddingRes) {
      return makeResponse(false, "Unable to save CV embedding", {}, 500);
    }

    const asset = await replaceAsset(existingProfile.cv?.publicId, file.buffer, {
      folder: CLOUDINARY_FOLDERS.cv,
      publicId: `${_user._id}-cv`,
      mimetype: file.mimetype,
      format: CV_EXT_BY_MIME[file.mimetype],
      resourceType: "auto",
    });

    update.cv = { url: asset.url, publicId: asset.publicId, uploadedAt: new Date() };
  }

  const profile = await userRepository.findProfileByIdAndUpdate(existingProfile._id, update);

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
