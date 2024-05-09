import * as jobRepository from "../../repository/v1/job";
import * as roleRepository from "../../repository/v1/role";
import * as userRepository from "../../repository/v1/user";
import { makeResponse } from "../../helpers/response";
import { FetchJobs, IJob } from "../../typings/job";
import mongoose from "mongoose";
import { IRole } from "../../typings/role";

export const createJob = async (payload: IJob) => {
  if (!mongoose.Types.ObjectId.isValid(payload.role as string)) {
    return makeResponse(false, "Invalid role id", {}, 400);
  }
  const existingRole = await roleRepository.findRoleById(payload.role as string);
  if (!existingRole) {
    return makeResponse(false, "Role does not exist", {}, 404);
  }
  //@TODO check if job already exists under organization
  let job = await jobRepository.createJob(payload);
  return makeResponse(true, "Job posted successfully", job, 200);
};

export const fetchAllJobs = async (payload: FetchJobs) => {
  let jobs: IJob[] = [];
  if (payload.roleId) {
    if (!mongoose.Types.ObjectId.isValid(payload.roleId)) {
      return makeResponse(false, "Invalid role id", {}, 400);
    }
    const role = await roleRepository.findRoleById(payload.roleId);
    if (!role) {
      return makeResponse(false, "Role does not exist", {}, 404);
    }
    jobs = await jobRepository.findAllJobs({ role: payload.roleId }, payload);
  } else {
    jobs = await jobRepository.findAllJobs({}, payload);
  }
  return makeResponse(true, "Jobs fetched successfully", jobs, 200);
};

export const fetchJob = async (payload: Pick<IJob, "_id">) => {
  if (!mongoose.Types.ObjectId.isValid(payload._id)) {
    return makeResponse(false, "Invalid job id", {}, 400);
  }
  let job = await jobRepository.findJobById(payload._id);
  if (!job) {
    return makeResponse(false, "Job not found", {}, 404);
  }
  return makeResponse(true, "Job fetched successfully", job, 200);
};

export const fuzzyMatch = async (payload: Pick<IJob, "_id">) => {
  if (!mongoose.Types.ObjectId.isValid(payload._id)) {
    return makeResponse(false, "Invalid job id", {}, 400);
  }
  let job = await jobRepository.findJobById(payload._id);
  if (!job) {
    return makeResponse(false, "Job not found", {}, 404);
  }

  //@TODO add check to view only jobs posted by organization of recruiter but if user is Admin proceed

  const talents = await userRepository.profileAggregate([
    {
      $match: {
        role: (job.role as IRole)._id,
        experience: job.experienceLevel,
        minSalary: { $gte: job.minSalary },
        maxSalary: { $lte: job.maxSalary },
      },
    },
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "profile",
        as: "user",
      },
    },
    {
      $unwind: "$user",
    },
    {
      $project: {
        "user.password": 0, // Exclude password field from user object
      },
    },
    {
      $sort: { "profile.score": -1 }, // Sort by score in descending order
    },
  ]);

  return makeResponse(true, "Job fetched successfully", { talents }, 200);
};
