import Job from "../../models/v1/job";
import { Page, Paging } from "../../typings/customs";
import { IJob } from "../../typings/job";
import { HydratedDocument, Types, UpdateQuery } from "mongoose";
import * as func from "../../helpers/func";

export const createJob = async (job: IJob): Promise<HydratedDocument<IJob>> => {
  return await new Job(job).save();
};

export const findJobById = async (id: Types.ObjectId | string) => {
  return await Job.findById(id).populate({
    path: "role postedBy",
    select: "-__v -createdAt -updatedAt",
    strictPopulate: false,
  });
};

export const findAllJobs = async (match: Partial<IJob>, paging: Paging = {}) => {
  return await Job.find(match)
    .sort({ updatedAt: func.sortDirection(paging.sort!) || Page.Sort })
    .skip(Number(paging.offset) || Page.Offset)
    .limit(Number(paging.limit) || Page.Limit)
    .populate({
      path: "role postedBy",
      select: "-__v -createdAt -updatedAt",
      strictPopulate: false,
    });
};

export const findJobByMatch = async (data: IJob | Record<string, any>) => {
  return await Job.findOne(data).populate({
    path: "role postedBy",
    select: "-__v -createdAt -updatedAt",
    strictPopulate: false,
  });
};

export const findJobByIdAndUpdate = async (
  JobId: string | Types.ObjectId,
  data: UpdateQuery<IJob>
) => {
  return await Job.findByIdAndUpdate(JobId, data, { new: true }).populate({
    path: "role postedBy",
    select: "-__v -createdAt -updatedAt",
    strictPopulate: false,
  });
};
