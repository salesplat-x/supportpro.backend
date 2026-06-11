import { sortDirection } from "../../helpers/func";
import scout from "../../models/v1/scout";
import { Page, Paging } from "../../typings/customs";
import { IScout } from "../../typings/scout";
import { FilterQuery, Types } from "mongoose";

export const createScout = async (data: Partial<IScout>) => {
  return await new scout(data).save();
};

export const createOrUpdateScout = async (recruiter: Types.ObjectId | string, data: IScout) => {
  return await scout.findOneAndUpdate({ recruiter }, data, {
    upsert: true,
    new: true,
  });
};

export const findAndUpdateScoutById = async (id: Types.ObjectId | string, data: IScout) => {
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

export const findScoutsByMatch = async (
  match: FilterQuery<IScout>,
  paging?: Paging,
  projection?: string
) => {
  if (paging) {
    return await scout
      .find(match, projection)
      .sort({ updatedAt: sortDirection(paging.sort!) || Page.Sort })
      .skip(Number(paging.offset) || Page.Offset)
      .limit(Number(paging.limit) || Page.Limit)
      .sort({ evaluationScore: "desc" });
  }
  return await scout.find(match, projection).sort({ evaluationScore: "desc" });
};
