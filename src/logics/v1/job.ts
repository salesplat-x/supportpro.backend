import * as jobRepository from "../../repository/v1/job";
import { makeResponse } from "../../helpers/response";
import { IJob } from "../../typings/job";

export const createJob = async (payload: IJob) => {
  //@TODO check if job exists
  let job = await jobRepository.createJob(payload);
  return makeResponse(true, "Job posted successfully", job, 200);
};

export const fetchAllJobs = async () => {
  let jobs = await jobRepository.findAllJobs();
  return makeResponse(true, "Jobs fetched successfully", jobs, 200);
};

export const fetchJob = async (payload: Pick<IJob, "_id">) => {
  let job = await jobRepository.findJobById(payload._id);
  if (!job) {
    return makeResponse(false, "Job not found", {}, 404);
  }
  return makeResponse(true, "Job fetched successfully", job, 200);
};
