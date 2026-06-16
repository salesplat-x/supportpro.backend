import { User, Profile } from "../../models/v1/user";
import { Page, Paging, Roles } from "../../typings/customs";
import { IUser, IProfile } from "../../typings/user";
import mongoose, { FilterQuery, HydratedDocument, Types } from "mongoose";
import * as func from "../../helpers/func";

export const createUser = async (user: IUser): Promise<HydratedDocument<IUser>> => {
  return await new User(user).save();
};

export const createTalentUserWithProfile = async (
  userPayload: IUser
): Promise<HydratedDocument<IUser>> => {
  let profileId: Types.ObjectId | string | undefined;
  if (userPayload.userRole === Roles.Talent || !userPayload.userRole) {
    const profile = await new Profile({ role: [] }).save();
    profileId = profile._id;
  }
  return await new User({ ...userPayload, profile: profileId }).save();
};

export const findUserById = async (id: Types.ObjectId | string) => {
  return await User.findById(id).populate({
    path: "profile",
    select: "-__v -createdAt -updatedAt ",
    strictPopulate: false,
    populate: { path: "role", model: "role", select: "-__v " },
  });
};

// findUserAuthById fetches only the fields needed by auth middleware, without populating
export const findUserAuthById = async (id: Types.ObjectId | string) => {
  return await User.findById(id).select("email userRole active emailVerified tokenVersion profile");
};

export const findUserAndScoreById = async (id: Types.ObjectId | string) => {
  return await User.findById(id).populate({
    path: "profile",
    select:
      "bio cv role experience currency maxSalary minSalary prescreeningScore location workType",
    strictPopulate: false,
    populate: { path: "role", model: "role", select: "-__v " },
  });
};

export const findProfileById = async (id: Types.ObjectId | string) => {
  return await Profile.findById(id).select("cv role");
};

export const findUserByEmail = async (email: string) => {
  return await User.findOne({ email }).populate({
    path: "profile",
    select: "-__v -createdAt -updatedAt ",
    strictPopulate: false,
    populate: { path: "role", model: "role", select: "-__v " },
  });
};

export const findUserByMatch = async (data: FilterQuery<IUser>) => {
  return await User.findOne(data).populate({
    path: "profile",
    select: "-__v -createdAt -updatedAt ",
    strictPopulate: false,
    populate: { path: "role", model: "role", select: "-__v " },
  });
};

export const findUsersByMatch = async (data: FilterQuery<IUser>, paging: Paging = {}) => {
  return await User.find(data)
    .sort({ updatedAt: func.sortDirection(paging.sort!) || Page.Sort })
    .skip(Number(paging.offset) || Page.Offset)
    .limit(Number(paging.limit) || Page.Limit)
    .select("-password")
    .populate({
      path: "profile",
      select: "-__v -createdAt -updatedAt",
      strictPopulate: false,
      populate: { path: "role", model: "role", select: "-__v " },
    });
};

export const userAggregate = async (data: mongoose.PipelineStage[], paging: Paging = {}) => {
  return await User.aggregate(data)
    // .sort({ updatedAt: func.sortDirection(paging.sort!) || Page.Sort })
    .skip(Number(paging.offset) || Page.Offset)
    .limit(Number(paging.limit) || Page.Limit);
};

export const findUserByIdAndUpdate = async (
  userId: string | Types.ObjectId,
  data: Partial<IUser>
) => {
  return await User.findByIdAndUpdate(userId, { $set: data }, { new: true }).populate({
    path: "profile",
    select: "-__v -createdAt -updatedAt ",
    strictPopulate: false,
    populate: { path: "role", model: "role", select: "-__v " },
  });
};

export const createProfile = async (
  profile: mongoose.AnyKeys<IProfile>
): Promise<HydratedDocument<IProfile>> => {
  return await new Profile(profile).save();
};

export const findProfileByIdAndUpdate = async (
  profileId: string | Types.ObjectId,
  data: Partial<IProfile>
) => {
  return await Profile.findByIdAndUpdate(
    profileId,
    { $set: data },
    {
      new: true,
    }
  ).populate({
    path: "role",
    select: "-__v",
    strictPopulate: false,
  });
};

export const updateUserScore = async (
  profileId: string | Types.ObjectId,
  prescreeningScore: number
) => {
  return await Profile.findByIdAndUpdate(profileId, { prescreeningScore }, { new: true }).populate({
    path: "role",
    select: "-__v",
    strictPopulate: false,
  });
};

export const profileAggregate = async (data: mongoose.PipelineStage[], paging: Paging = {}) => {
  return await Profile.aggregate(data)
    .skip(Number(paging.offset) || Page.Offset)
    .limit(Number(paging.limit) || Page.Limit);
};
