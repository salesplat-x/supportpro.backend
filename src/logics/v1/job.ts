import * as jobRepository from "../../repository/v1/job";
import * as roleRepository from "../../repository/v1/role";
import { makeResponse } from "../../helpers/response";
import { IJob } from "../../typings/job";

export const createJob = async (payload: IJob) => {
  const existingRole = await roleRepository.findRoleById(payload.role as string);
  if (!existingRole) {
    return makeResponse(false, "Role does not exist", {}, 404);
  }
  //@TODO check if job already exists under organization
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
