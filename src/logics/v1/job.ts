import * as jobRepository from "../../repository/v1/job";
import * as applicationRepository from "../../repository/v1/application";
import * as roleRepository from "../../repository/v1/role";
import * as userRepository from "../../repository/v1/user";
import * as pgRepository from "../../repository/v1/pg";
import { makeResponse } from "../../helpers/response";
import { FetchJobs, IJob, MatchJob, TopTalents } from "../../typings/job";
import mongoose from "mongoose";
import { IRole } from "../../typings/role";
import { Roles } from "../../typings/customs";
import { createEmbedding } from "../../services/v1/openai";
import {
  convertSimilarityToPercentage,
  preprocessText,
} from "../../helpers/func";
import { IUser } from "../../typings/user";
import { ApplicationType } from "../../typings/application";

export const createJob = async (user: IUser, payload: IJob) => {
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

  payload.postedBy = user._id;
  let job = await jobRepository.createJob(payload);

  // Save job embedding in vectorDB
  const res = await pgRepository.saveJobEmbedding(
    job._id.toString(),
    job.description,
    jobEmbedding[0]?.embedding!
  );
  if (!res) {
    return makeResponse(false, "Unable to save job embedding", {}, 500);
  }

  return makeResponse(true, "Job posted successfully", job, 200);
};

export const updateJob = async (user: IUser, payload: IJob) => {
  const { _id, ...update } = payload;

  const existingJob = await jobRepository.findJobById(_id);
  if (!existingJob) {
    return makeResponse(false, "Job does not exist", {}, 404);
  }

  if ((existingJob.postedBy as IUser)._id.toString() !== user._id.toString()) {
    return makeResponse(
      false,
      "You are not authorized to perform this action",
      403
    );
  }

  if (update.role) {
    if (!mongoose.Types.ObjectId.isValid(update.role as string)) {
      return makeResponse(false, "Invalid role id", {}, 400);
    }
    const existingRole = await roleRepository.findRoleById(
      update.role as string
    );
    if (!existingRole) {
      return makeResponse(false, "Role does not exist", {}, 404);
    }
  }
  console.log(update);
  const job = await jobRepository.findJobByIdAndUpdate(_id, update);
  if (!job) {
    return makeResponse(false, "Unable to update job", {}, 400);
  }
  if (update.description) {
    //@TODO create and replace job embedding if
  }

  return makeResponse(true, "Job updated successfully", job, 200);
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

// Function to to get talents based on profile and job similarity
export const matchJob = async (user: IUser, payload: MatchJob) => {
  if (!mongoose.Types.ObjectId.isValid(payload._id)) {
    return makeResponse(false, "Invalid job id", {}, 400);
  }
  let job = await jobRepository.findJobById(payload._id);
  if (!job) {
    return makeResponse(false, "Job not found", {}, 404);
  }

  //Check if job was posted by user or if user is Admin
  if (
    (job.postedBy as IUser)._id.toString() !== user._id.toString() &&
    user.userRole !== Roles.Admin
  ) {
    return makeResponse(
      false,
      "You are not authorized to perform this action",
      403
    );
  }

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
      $sort: { "profile.prescreeningScore": -1 }, // Sort by prescreeningScore in descending order
    },
  ];
  if (payload.incomplete != "true") {
    pipeline.push({
      $match: {
        "profile.prescreeningScore": { $exists: true },
      },
    });
  }
  const talents = await userRepository.userAggregate(pipeline);

  return makeResponse(true, "Job fetched successfully", { talents }, 200);
};

// Function to get talents based on CV and JD embedding similarity
export const topTalents = async (user: IUser, payload: TopTalents) => {
  const { jobId } = payload;

  if (!mongoose.Types.ObjectId.isValid(jobId)) {
    return makeResponse(false, "Invalid job id", {}, 400);
  }
  const job = await jobRepository.findJobById(jobId);
  if (!job) {
    return makeResponse(false, "Job does not exist", {}, 404);
  }

  //Check if job was posted by user or if user is Admin
  if (
    (job.postedBy as IUser)._id.toString() !== user._id.toString() &&
    user.userRole !== Roles.Admin
  ) {
    return makeResponse(
      false,
      "You are not authorized to perform this action",
      403
    );
  }

  const res = await pgRepository.getTopCVEmbedding(payload);

  const talentIds = res.map((r: any) => r.profile_id);

  const bulkOps = res.map((r: any) => {
    const talentId = r.profile_id;
    const cvSimilarityScore = convertSimilarityToPercentage(r.similarity);
    return {
      updateOne: {
        filter: { job: jobId, talent: talentId },
        update: {
          $set: { cvSimilarityScore },
          $setOnInsert: { applicationType: ApplicationType.Invitation },
        },
        upsert: true,
      },
    };
  });

  // Execute bulk operations in MongoDB
  if (bulkOps.length > 0) {
    await applicationRepository.bulkWrite(bulkOps);
  }

  const talents = await userRepository.findUsersByMatch({
    _id: { $in: talentIds },
  });
  //@TODO send out invitations to talents

  return makeResponse(true, "Top talents fetched", { talents }, 200);
};
