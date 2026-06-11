import ScoutJob from "../../models/v1/scoutJob";
import { Page, Paging } from "../../typings/customs";
import { IScoutJob } from "../../typings/scoutJob";
import { HydratedDocument, Types, UpdateQuery } from "mongoose";
import * as func from "../../helpers/func";

export const createScoutJob = async (scoutJob: IScoutJob): Promise<HydratedDocument<IScoutJob>> => {
  return await new ScoutJob(scoutJob).save();
};

export const findScoutJobById = async (
  id: Types.ObjectId | string,
  projection = "role postedBy"
) => {
  return await ScoutJob.findById(id).populate(projection);
};

export const findAllScoutJobs = async (match: Partial<IScoutJob>, paging: Paging = {}) => {
  return await ScoutJob.find(match)
    .sort({ updatedAt: func.sortDirection(paging.sort!) || Page.Sort })
    .skip(Number(paging.offset) || Page.Offset)
    .limit(Number(paging.limit) || Page.Limit)
    .populate({
      path: "role postedBy",
      select: "-__v -createdAt -updatedAt",
      strictPopulate: false,
    });
};

export const findScoutJobByMatch = async (data: IScoutJob | Record<string, any>) => {
  return await ScoutJob.findOne(data).populate({
    path: "role postedBy",
    select: "-__v -createdAt -updatedAt",
    strictPopulate: false,
  });
};

export const findScoutJobByIdAndUpdate = async (
  ScoutJobId: string | Types.ObjectId,
  data: UpdateQuery<IScoutJob>
) => {
  return await ScoutJob.findByIdAndUpdate(ScoutJobId, data, {
    new: true,
  }).populate({
    path: "role postedBy",
    select: "-__v -createdAt -updatedAt",
    strictPopulate: false,
  });
};
