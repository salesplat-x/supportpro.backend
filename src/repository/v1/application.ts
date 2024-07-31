import Application from "../../models/v1/application";
import { Page, Paging } from "../../typings/customs";
import { IApplication, TScreeningStage } from "../../typings/application";
import { FilterQuery, PipelineStage, Types, UpdateQuery } from "mongoose";
import * as func from "../../helpers/func";

export const createApplication = (application: Partial<IApplication>) => {
  return new Application(application);
};

export const bulkWrite = async (
  // bulkOps: AnyBulkWriteOperation<IApplication>[]
  bulkOps: any
) => {
  return await Application.bulkWrite(bulkOps);
};

export const findApplicationById = async (id: Types.ObjectId | string) => {
  return await Application.findById(id).populate({
    path: "role job talent",
    select: "-__v -createdAt -updatedAt ",
    strictPopulate: false,
  });
};

export const createOrUpdateApplication = async (
  job: string | Types.ObjectId,
  talent: string | Types.ObjectId,
  update: Partial<IApplication> | UpdateQuery<IApplication>
) => {
  return await Application.findOneAndUpdate(
    { job, talent },
    { ...update },
    {
      upsert: true,
      new: true,
      includeResultMetadata: true,
      runValidators: true,
    }
  );
};

export const findAllApplications = async (paging: Paging = {}) => {
  return await Application.find()
    .sort({ updatedAt: func.sortDirection(paging.sort!) || Page.Sort })
    .skip(Number(paging.offset) || Page.Offset)
    .limit(Number(paging.limit) || Page.Limit)
    .populate({
      path: "role",
      select: "-__v -createdAt -updatedAt ",
      strictPopulate: false,
    });
};

export const findApplicationByMatch = async (
  data: IApplication | Record<string, any>
) => {
  return await Application.findOne(data);
};

export const findApplicationsByMatch = async (
  data: IApplication | Record<string, any>,
  paging: Paging = {}
) => {
  return await Application.find(data)
    .populate({
      path: "job",
      select: "-ai_config",
      strictPopulate: false,
    })
    .select("-personalizedQuestions")
    .sort({ updatedAt: -1 })
    .skip(Number(paging.offset) || Page.Offset)
    .limit(Number(paging.limit) || Page.Limit);
};

export const findApplicationByMatchAndUpdate = async (
  filter: FilterQuery<IApplication>,
  data: Partial<IApplication>
) => {
  return await Application.findOneAndUpdate(filter, data, {
    new: true,
  });
};

export const applicationAggregate = async (
  data: PipelineStage[],
  paging: Paging = {}
) => {
  return await Application.aggregate(data);
};

// Update current stage of application
export const updateCurrentStage = (
  currentStage: TScreeningStage,
  stages: Map<TScreeningStage, TScreeningStage>
) => {
  const nextStage = stages.get(currentStage);

  if (nextStage) {
    return nextStage;
  } else {
    throw new Error("Next stage not found");
  }
};
