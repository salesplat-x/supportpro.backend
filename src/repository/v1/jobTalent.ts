import JobTalent from "../../models/v1/jobTalent";
import { Page, Paging } from "../../typings/customs";
import { IJobTalent } from "../../typings/jobTalent";
import { AnyBulkWriteOperation, HydratedDocument, Types } from "mongoose";
import * as func from "../../helpers/func";

export const createJobTalent = async (
  jobTalent: IJobTalent
): Promise<HydratedDocument<IJobTalent>> => {
  return await new JobTalent(jobTalent).save();
};

export const bulkWrite = async (
  bulkOps: AnyBulkWriteOperation<IJobTalent>[]
) => {
  return await JobTalent.bulkWrite(bulkOps);
};

export const findJobTalentById = async (id: Types.ObjectId | string) => {
  return await JobTalent.findById(id).populate({
    path: "role job talent",
    select: "-__v -createdAt -updatedAt ",
    strictPopulate: false,
  });
};

export const createOrUpdateJobTalent = async (
  job: string | Types.ObjectId,
  talent: string | Types.ObjectId,
  update: Partial<IJobTalent>
) => {
  return await JobTalent.findOneAndUpdate(
    { job, talent },
    { ...update },
    {
      upsert: true,
      new: true,
      runValidators: true,
    }
  );
};

export const findAllJobTalents = async (paging: Paging = {}) => {
  return await JobTalent.find()
    .sort({ updatedAt: func.sortDirection(paging.sort!) || Page.Sort })
    .skip(Number(paging.offset) || Page.Offset)
    .limit(Number(paging.limit) || Page.Limit)
    .populate({
      path: "role",
      select: "-__v -createdAt -updatedAt ",
      strictPopulate: false,
    });
};

export const findJobTalentsByMatch = async (
  data: IJobTalent | Record<string, any>,
  paging: Paging = {}
) => {
  return await JobTalent.find(data)
    .select("personalizedQuestions")
    .sort({ updatedAt: func.sortDirection(paging.sort!) || Page.Sort })
    .skip(Number(paging.offset) || Page.Offset)
    .limit(Number(paging.limit) || Page.Limit);
};

export const findJobTalentByIdAndUpdate = async (
  JobTalentId: string | Types.ObjectId,
  data: Partial<IJobTalent>
) => {
  return await JobTalent.findByIdAndUpdate(JobTalentId, data, {
    new: true,
  }).populate({
    path: "role",
    select: "-__v -createdAt -updatedAt ",
    strictPopulate: false,
  });
};
