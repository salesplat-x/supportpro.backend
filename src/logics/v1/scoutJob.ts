import * as scoutJobRepository from "../../repository/v1/scoutJob";
import * as roleRepository from "../../repository/v1/role";
import { makeResponse } from "../../helpers/response";
import { IScoutJob } from "../../typings/scoutJob";
import { Types } from "mongoose";
import { IUser } from "../../typings/user";
import { preprocessText } from "../../helpers/func";
import { createEmbedding } from "../../services/v1/openai";
import { saveScoutJobEmbedding } from "../../repository/v1/pg";

export const createJob = async (user: IUser, payload: IScoutJob) => {
  if (!Types.ObjectId.isValid(payload.role as string)) {
    return makeResponse(false, "Invalid role id", {}, 400);
  }
  const existingRole = await roleRepository.findRoleById(payload.role as string);
  if (!existingRole) {
    return makeResponse(false, "Role does not exist", {}, 404);
  }

  // create embedding for job description
  const jd = preprocessText(`${payload.jobBrief} \n ${payload.recruiterGuide}`);
  const jobEmbedding = await createEmbedding(jd);
  if (!jobEmbedding || !jobEmbedding[0]?.embedding) {
    return makeResponse(false, "Unable to create vector embedding for JD", {}, 400);
  }

  payload.postedBy = user._id;
  const scoutJob = await scoutJobRepository.createScoutJob(payload);

  // Save job embedding in vectorDB
  const res = await saveScoutJobEmbedding(
    scoutJob.id,
    scoutJob.jobBrief,
    jobEmbedding[0]!.embedding
  );
  if (!res) {
    return makeResponse(false, "Unable to save job embedding", {}, 500);
  }

  return makeResponse(true, "Job posted successfully", scoutJob, 200);
};

export const updateJob = async (user: IUser, payload: IScoutJob) => {
  const { _id, ...update } = payload;

  const existingJob = await scoutJobRepository.findScoutJobById(_id);
  if (!existingJob) {
    return makeResponse(false, "Job does not exist", {}, 404);
  }

  if ((existingJob.postedBy as IUser)._id.toString() !== user._id.toString()) {
    return makeResponse(false, "You are not authorized to perform this action", 403);
  }

  if (update.role) {
    if (!Types.ObjectId.isValid(update.role as string)) {
      return makeResponse(false, "Invalid role id", {}, 400);
    }
    const existingRole = await roleRepository.findRoleById(update.role as string);
    if (!existingRole) {
      return makeResponse(false, "Role does not exist", {}, 404);
    }
  }

  const scoutJob = await scoutJobRepository.findScoutJobByIdAndUpdate(_id, update);
  if (!scoutJob) {
    return makeResponse(false, "Unable to update scoutJob", {}, 400);
  }

  return makeResponse(true, "Job updated successfully", scoutJob, 200);
};

export const fetchJob = async (payload: Pick<IScoutJob, "_id">) => {
  if (!Types.ObjectId.isValid(payload._id)) {
    return makeResponse(false, "Invalid scoutJob id", {}, 400);
  }
  const scoutJob = await scoutJobRepository.findScoutJobById(payload._id);
  if (!scoutJob) {
    return makeResponse(false, "Job not found", {}, 404);
  }
  return makeResponse(true, "Job fetched successfully", scoutJob, 200);
};
