import { User, Profile } from "../../models/v1/user";
import { IUser, IProfile } from "../../typings/user";
import { HydratedDocument, Types } from "mongoose";

export const createUser = async (
  user: IUser
): Promise<HydratedDocument<IUser>> => {
  return await new User(user).save();
};

export const findUserById = async (id: Types.ObjectId | string) => {
  return await User.findById(id).populate({
    path: "profile",
    select: "-__v -createdAt -updatedAt -_id",
    strictPopulate: false,
    populate: { path: "role", model: "role", select: "-__v -_id" },
  });
};

export const findUserAndScoreById = async (id: Types.ObjectId | string) => {
  return await User.findById(id).populate({
    path: "profile",
    select: "bio cv role experience maxSalary minSalary score",
    strictPopulate: false,
    populate: { path: "role", model: "role", select: "-__v -_id" },
  });
};

export const findUserByEmail = async (email: string) => {
  return await User.findOne({ email }).populate({
    path: "profile",
    select: "-__v -createdAt -updatedAt -_id",
    strictPopulate: false,
    populate: { path: "role", model: "role", select: "-__v -_id" },
  });
};

export const findUserByMatch = async (data: IUser | Record<string, any>) => {
  return await User.findOne(data).populate({
    path: "profile",
    select: "-__v -createdAt -updatedAt -_id",
    strictPopulate: false,
    populate: { path: "role", model: "role", select: "-__v -_id" },
  });
};

export const findUserByIdAndUpdate = async (
  userId: string | Types.ObjectId,
  data: Partial<IUser>
) => {
  return await User.findByIdAndUpdate(userId, data, { new: true }).populate({
    path: "profile",
    select: "-__v -createdAt -updatedAt -_id",
    strictPopulate: false,
    populate: { path: "role", model: "role", select: "-__v -_id" },
  });
};

export const createProfile = async (
  profile: IProfile
): Promise<HydratedDocument<IProfile>> => {
  return await new Profile(profile).save();
};

export const findProfileByIdAndUpdate = async (
  profileId: string | Types.ObjectId,
  data: Partial<IProfile>
) => {
  return await Profile.findByIdAndUpdate(profileId, data, {
    new: true,
  }).populate({
    path: "profile",
    select: "-__v -createdAt -updatedAt -_id",
    strictPopulate: false,
    populate: { path: "role", model: "role", select: "-__v -_id" },
  });
};
