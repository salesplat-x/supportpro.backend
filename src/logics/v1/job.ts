import * as jobRepository from "../../repository/v1/job";
import * as roleRepository from "../../repository/v1/role";
import * as userRepository from "../../repository/v1/user";
import { makeResponse } from "../../helpers/response";
import { FetchJobs, IJob, MatchJob, TopTalents } from "../../typings/job";
import mongoose from "mongoose";
import { IRole } from "../../typings/role";
import { Roles } from "../../typings/customs";
import { createEmbedding } from "../../servces/v1/openai";
import { getTopCVEmbedding, saveJobEmbedding } from "../../repository/v1/pg";
import { preprocessText } from "../../helpers/func";

export const createJob = async (payload: IJob) => {
  if (!mongoose.Types.ObjectId.isValid(payload.role as string)) {
    return makeResponse(false, "Invalid role id", {}, 400);
  }
  const existingRole = await roleRepository.findRoleById(payload.role as string);
  if (!existingRole) {
    return makeResponse(false, "Role does not exist", {}, 404);
  }
  //@TODO check if job already exists under organization

  // Create vector embedding for Job description
  const jd = preprocessText(payload.description);
  const jobEmbedding = await createEmbedding(jd);
  if (!jobEmbedding || !jobEmbedding[0]?.embedding) {
    return makeResponse(
      false,
      "Unable to create vector embedding for JD",
      {},
      400
    );
  }

  let job = await jobRepository.createJob(payload);

  // Save job embedding in vectorDB
  const res = await saveJobEmbedding(
    job._id.toString(),
    job.description,
    jobEmbedding[0]?.embedding!
  );
  if (!res) {
    return makeResponse(false, "Unable to save job embedding", {}, 500);
  }

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

export const matchJob = async (payload: MatchJob) => {
  if (!mongoose.Types.ObjectId.isValid(payload._id)) {
    return makeResponse(false, "Invalid job id", {}, 400);
  }
  let job = await jobRepository.findJobById(payload._id);
  if (!job) {
    return makeResponse(false, "Job not found", {}, 404);
  }

  //@TODO add check to view only jobs posted by organization of recruiter but if user is Admin proceed

  let pipeline: mongoose.PipelineStage[] = [
    {
      $match: {
        userRole: Roles.Talent,
      },
    },
    {
      $project: {
        password: 0, // Exclude password field from user object
      },
    },
    {
      $lookup: {
        from: "profiles",
        localField: "profile",
        foreignField: "_id",
        as: "profile",
      },
    },
    { $unwind: "$profile" },
    {
      $match: {
        "profile.role": (job.role as IRole)._id,
        "profile.experience": job.experienceLevel,
        // "profile.minSalary": { $gte: job.minSalary },
        "profile.maxSalary": { $lte: job.maxSalary },
      },
    },
    {
      $lookup: {
        from: "roles",
        localField: "profile.role",
        foreignField: "_id",
        as: "profile.role",
      },
    },
    {
      $sort: { "profile.assessmentScore": -1 }, // Sort by assessmentScore in descending order
    },
  ];
  if (payload.incomplete != "true") {
    pipeline.push({
      $match: {
        "profile.assessmentScore": { $exists: true },
      },
    });
  }
  const talents = await userRepository.userAggregate(pipeline);

  return makeResponse(true, "Job fetched successfully", { talents }, 200);
};

export const topTalents = async (payload: TopTalents) => {
  if (!mongoose.Types.ObjectId.isValid(payload.jobId)) {
    return makeResponse(false, "Invalid job id", {}, 400);
  }
  const job = await jobRepository.findJobById(payload.jobId);
  if (!job) {
    return makeResponse(false, "Job does not exist", {}, 404);
  }
  const res = await getTopCVEmbedding(payload);

  const talentIds = res.map((r: any) => r.profile_id);
  const talents = await userRepository.findUsersByMatch({
    _id: { $in: talentIds },
  });
  return makeResponse(true, "Top talents fetched", { talents }, 200);
};
