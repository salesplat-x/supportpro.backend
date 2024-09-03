import scout from "../../models/v1/scout";
import { IScout } from "../../typings/scout";
import { FilterQuery, Types } from "mongoose";

export const createScout = async (data: Partial<IScout>) => {
  return await new scout(data).save();
};

export const createOrUpdateScout = async (
  recruiter: Types.ObjectId | string,
  data: IScout
) => {
  return await scout.findOneAndUpdate({ recruiter }, data, {
    upsert: true,
    new: true,
  });
};

export const findAndUpdateScoutById = async (
  id: Types.ObjectId | string,
  data: IScout
) => {
  return await scout.findByIdAndUpdate(id, data, {
    new: true,
  });
};

export const findScoutById = async (id: Types.ObjectId | string) => {
  return await scout.findById(id);
};

export const findScoutByMatch = async (match: FilterQuery<IScout>) => {
  return await scout.findOne(match);
};

export const findScoutsByMatch = async (match: FilterQuery<IScout>) => {
  return await scout.find(match).sort({ evaluationScore: "desc" });
};
