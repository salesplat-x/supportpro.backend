import * as jobRepository from "../../repository/v1/job";
import * as notificationRepository from "../../repository/v1/notification";
import * as applicationRepository from "../../repository/v1/application";
import * as aiConfigRepository from "../../repository/v1/AIconfig";
import * as roleRepository from "../../repository/v1/role";
import * as userRepository from "../../repository/v1/user";
import * as pgRepository from "../../repository/v1/pg";
import { IApplication } from "../../typings/application";
import { Document } from "mongoose";
import { makeResponse } from "../../helpers/response";
import {
  FetchJobs,
  IApply,
  IFetchApplications,
  IJob,
  JobStatus,
  MatchJob,
  TopTalents,
} from "../../typings/job";
import mongoose, { Types, PipelineStage, FilterQuery } from "mongoose";
import { IRole } from "../../typings/role";
import { Roles } from "../../typings/customs";
import { createEmbedding } from "../../services/v1/openai";
import {
  convertSimilarityToPercentage,
  preprocessText,
} from "../../helpers/func";
import { IProfile, IUser } from "../../typings/user";
import {
  ApplicationStatus,
  ApplicationType,
  //IApplication,
  ScreeningStage,
} from "../../typings/application";
import { INotification } from "../../typings/notification";

export const createJob = async (user: IUser, payload: IJob) => {
  const role = payload.role as string;

  // check if the role id is used
  if (mongoose.Types.ObjectId.isValid(role)) {
    const existingRole = await roleRepository.findRoleById(
      payload.role as string
    );
    if (!existingRole) {
      return makeResponse(false, "Role does not exist", {}, 404);
    }
  } else {
    // If role is not ObjectId but a string create it if it does not exist
    let existingRole = await roleRepository.findRoleByMatch({
      name: role.toLowerCase(),
    });
    if (!existingRole) {
      existingRole = await roleRepository.createRole({ name: role });
    }
    payload.role = existingRole.id;
  }

  if (payload.aiConfig) {
    if (!Types.ObjectId.isValid(payload.aiConfig as string)) {
      return makeResponse(false, "Invalid aiConfig id", {}, 400);
    }
    const existingConfig = await aiConfigRepository.findAIconfigById(
      payload.aiConfig as string
    );
    if (!existingConfig) {
      return makeResponse(false, "Config does not exist", {}, 404);
    }
  }
  //@TODO check if job already exists under organization

  // Create vector embedding for Job description
  const jd = preprocessText(payload.jobBrief);
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
    job.jobBrief,
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
    if (!Types.ObjectId.isValid(update.role as string)) {
      return makeResponse(false, "Invalid role id", {}, 400);
    }
    const existingRole = await roleRepository.findRoleById(
      update.role as string
    );
    if (!existingRole) {
      return makeResponse(false, "Role does not exist", {}, 404);
    }
  }

  if (update.status && update.status !== existingJob.status) {
    const applications = await applicationRepository.findApplicationsByMatch({
      job: existingJob.id,
      $and: [
        { status: { $ne: ApplicationStatus.Shortlisted } },
        { status: { $ne: ApplicationStatus.Rejected } },
      ],
    });

    const notifications = applications.map(
      (application: IApplication): Partial<INotification> => {
        const _id = new Types.ObjectId();
        return {
          _id,
          user: application.talent,
          message: `Applications for this job has been ${update.status}`,
        };
      }
    );

    await notificationRepository.insertMany(notifications);
  }

  const job = await jobRepository.findJobByIdAndUpdate(_id, update);
  if (!job) {
    return makeResponse(false, "Unable to update job", {}, 400);
  }
  if (update.jobBrief) {
    //@TODO create and replace job embedding if
  }

  return makeResponse(true, "Job updated successfully", job, 200);
};

export const fetchAllJobs = async (payload: FetchJobs) => {
  let jobs: IJob[] = [];
  let query: FilterQuery<IJob> = {};

  if (payload.roleId) {
    if (!Types.ObjectId.isValid(payload.roleId)) {
      return makeResponse(false, "Invalid role id", {}, 400);
    }
    const role = await roleRepository.findRoleById(payload.roleId);
    if (!role) {
      return makeResponse(false, "Role does not exist", {}, 404);
    }
    query.role = payload.roleId;
  }
  if (payload.status) {
    query.status = payload.status;
  }
  if (payload.experienceLevel) {
    query.experienceLevel = payload.experienceLevel;
  }
  if (payload.postedBy) {
    query.postedBy = payload.postedBy;
  }
  if (payload.city) {
    query["location.city"] = payload.city.toLowerCase();
  }
  if (payload.state) {
    query["location.state"] = payload.state.toLowerCase();
  }
  if (payload.country) {
    query["location.country"] = payload.country.toLowerCase();
  }
  if (payload.workMode) {
    query.workMode = payload.workMode;
  }
  jobs = await jobRepository.findAllJobs(query, payload);
  return makeResponse(true, "Jobs fetched successfully", jobs, 200);
};

export const fetchJob = async (payload: Pick<IJob, "_id">) => {
  if (!Types.ObjectId.isValid(payload._id)) {
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
  if (!Types.ObjectId.isValid(payload._id)) {
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

  let pipeline: PipelineStage[] = [
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

  return makeResponse(
    true,
    "Job matches fetched successfully",
    { talents },
    200
  );
};

// Function to get talents based on CV and JD embedding similarity
export const topTalents = async (user: IUser, payload: TopTalents) => {
  const { jobId } = payload;

  if (!Types.ObjectId.isValid(jobId)) {
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

  // CV Similarity Logic
  const aiConfig = await aiConfigRepository.findAIconfigById(
    job.aiConfig as string
  );
  if (!aiConfig) {
    return makeResponse(false, "AI configuration for job not found!", {}, 404);
  }

  if (!aiConfig.cvSimilarity) {
    return makeResponse(
      false,
      "This feature was not configured for this job!",
      {},
      400
    );
  }
  payload.limit = aiConfig.noOfCvSimilarCandidates;
  payload.percentage = aiConfig.minCvSimilarityScore;
  const res = await pgRepository.getTopCVEmbedding(payload);

  const talentIds = res.map((r: any) => r.profile_id);

  const currentStage = applicationRepository.updateCurrentStage(
    ScreeningStage.CvSimilarity,
    aiConfig.stages
  ).currentStage;

  const bulkOps = res.map((r: any) => {
    const talentId = r.profile_id;
    const cvSimilarityScore = convertSimilarityToPercentage(r.similarity);

    return {
      updateOne: {
        filter: { job: jobId, talent: talentId },
        update: {
          $set: { cvSimilarityScore, currentStage },
          $setOnInsert: {
            recruiter: (job.postedBy as IUser)._id,
            applicationType: ApplicationType.Invitation,
            stages: aiConfig.stages,
          },
        },
        upsert: true,
      },
    };
  });

  let newApplicants = 0;

  // Execute bulk operations in MongoDB
  if (bulkOps.length > 0) {
    const { insertedCount } = await applicationRepository.bulkWrite(bulkOps);
    newApplicants = insertedCount;
  }

  const talents = await userRepository.findUsersByMatch({
    _id: { $in: talentIds },
  });

  job.noOfApplicants += newApplicants;
  await job.save();
  //@TODO send out invitations to talents

  return makeResponse(true, "Top talents fetched", { talents }, 200);
};

// Function for talents to grade CV and JD embedding similarity
export const gradeCv = async (user: IUser, jobId: string) => {
  if (!Types.ObjectId.isValid(jobId)) {
    return makeResponse(false, "Invalid job id", {}, 400);
  }
  const job = await jobRepository.findJobById(jobId);
  if (!job) {
    return makeResponse(false, "Job does not exist", {}, 404);
  }

  if (job.status === JobStatus.Closed) {
    return makeResponse(
      false,
      `Applications for this job is currently ${job.status}!`
    );
  }

  //let application = await applicationRepository.findApplicationByMatch({
  //  talent: user._id,
  //  job: jobId,
  //});

  let application: (IApplication & Document) | null =
    await applicationRepository.findApplicationByMatch(
      { talent: user._id, job: jobId }
    );

  if (!application) {
    return makeResponse(
      true,
      "You have to apply for this job before proceeding",
      {
        application,
      }
    );
  }

  // CV Similarity Logic
  const aiConfig = await aiConfigRepository.findAIconfigById(
    job.aiConfig as string
  );
  if (!aiConfig) {
    return makeResponse(false, "AI configuration for job not found!", {}, 404);
  }

  if (!aiConfig.cvSimilarity) {
    return makeResponse(
      false,
      "This feature was not configured for this job!",
      {},
      400
    );
  }

  let cvSimilarityScore = await pgRepository.getCVSimilarityScore(
    user._id as string,
    jobId
  );

  let { currentStage, applicationStatus } =
    applicationRepository.updateCurrentStage(
      ScreeningStage.CvSimilarity,
      aiConfig.stages
    );

  cvSimilarityScore = convertSimilarityToPercentage(cvSimilarityScore);
  if (cvSimilarityScore < aiConfig.minCvSimilarityScore) {
    applicationStatus = ApplicationStatus.RetakeAssessment;
  }

  application.cvSimilarityScore = cvSimilarityScore;
  // Update application status based on score
  if (cvSimilarityScore < aiConfig.minCvSimilarityScore) {
    applicationStatus = ApplicationStatus.RetakeAssessment;
    application.currentStage = ScreeningStage.CvSimilarity;
    application.status = ApplicationStatus.RetakeAssessment;
    application.setAssessmentRetryDate();
  //} else {
  //  application = await applicationRepository.processNextStage(
  //    user,
  //    application,
  //    ScreeningStage.CvSimilarity
  //  );
  //}
  //
  //await application.save();
  
  } else {
    // processNextStage returns plain IApplication, so cast it back to a Document
    application = (
      await applicationRepository.processNextStage(
        user,
        application,
        ScreeningStage.CvSimilarity
      )
    ) as IApplication & Document;
  }
  
  // Guard to ensure application is not null before calling save
  if (!application) {
    throw new Error("Application unexpectedly null after processing next stage");
  }
  await application.save();

  // const applicationRes = await applicationRepository.createOrUpdateApplication(
  //   jobId,
  //   user._id,
  //   {
  //     cvSimilarityScore,
  //     status: applicationStatus,
  //     currentStage,
  //     $setOnInsert: {
  //       recruiter: (job.postedBy as IUser)._id,
  //       applicationType: ApplicationType.Application,
  //       stages: aiConfig.stages,
  //     },
  //   }
  // );

  // // Increase number of applications if new application created
  // if (!applicationRes.lastErrorObject?.updatedExisting) {
  //   await jobRepository.findJobByIdAndUpdate(jobId, {
  //     $inc: { noOfApplicants: 1 },
  //   });
  // }

  await job.save();

  return makeResponse(
    true,
    "CV similarity graded",
    { cvSimilarityScore, application },
    200
  );
};

// Function to get job Applications
export const applications = async (user: IUser, payload: IFetchApplications) => {
  const {
    jobId,
    applicationType,
    applicationStatus,
    minCvSimilarityScore,
    minPersonalizedScore,
    experience,
    minSalary,
    maxSalary,
    offset,
    limit,
  } = payload;

  const job = await jobRepository.findJobById(jobId);
  if (!job) {
    return makeResponse(false, "Job not found", {}, 404);
  }
  if ((job.postedBy as IUser)._id.toString() !== user._id.toString()) {
    return makeResponse(
      false,
      "You are not authorized to perform this action",
      {},
      403
    );
  }

  // Build the match conditions for the application
  const applicationMatch: any = { job: new Types.ObjectId(jobId) };
  if (applicationType) {
    applicationMatch.applicationType = applicationType;
  }
  if (applicationStatus) {
    applicationMatch.status = applicationStatus;
  }
  if (minCvSimilarityScore) {
    applicationMatch.cvSimilarityScore = { $gte: Number(minCvSimilarityScore) };
  }
  if (minPersonalizedScore) {
    applicationMatch.personalizedScore = { $gte: Number(minPersonalizedScore) };
  }

  // Build the match conditions for the profile
  const profileMatch: any = {};
  if (experience) {
    profileMatch["profile.experience"] = experience;
  }
  // if (minSalary) {
  //   profileMatch["profile.minSalary"] = { $gte: Number(minSalary) };
  // }
  if (maxSalary) {
    profileMatch["profile.maxSalary"] = { $lte: Number(maxSalary) };
  }

  // Aggregation pipeline
  const pipeline: PipelineStage[] = [
    {
      $match: applicationMatch,
    },
    {
      $lookup: {
        from: "users",
        localField: "talent",
        foreignField: "_id",
        as: "talent",
      },
    },
    {
      $unwind: "$talent",
    },
    {
      $lookup: {
        from: "profiles",
        localField: "talent.profile",
        foreignField: "_id",
        as: "profile",
      },
    },
    {
      $unwind: "$profile",
    },
    {
      $match: profileMatch,
    },
    {
      $sort: {
        cvSimilarityScore: -1,
        personalizedScore: -1,
        createdAt: -1,
      },
    },
  ];

  // Add optional pagination stages if limit and skip are provided
  if (offset) {
    pipeline.push({ $skip: Number(offset) });
  }
  if (limit) {
    pipeline.push({ $limit: Number(limit) });
  }

  pipeline.push({
    $project: {
      _id: 1,
      job: 1,
      talent: {
        _id: "$talent._id",
        email: "$talent.email",
        firstName: "$talent.firstName",
        lastName: "$talent.lastName",
        profile: {
          _id: "$profile._id",
          bio: "$profile.bio",
          experience: "$profile.experience",
          maxSalary: "$profile.maxSalary",
          minSalary: "$profile.minSalary",
        },
      },
      applicationType: 1,
      status: 1,
      personalizedScore: 1,
      cvSimilarityScore: 1,
      mbtiType: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  });

  const applications = await applicationRepository.applicationAggregate(
    pipeline
  );
  return makeResponse(true, "Job applications fetched", { applications });
};

// Function to apply for job
export const apply = async (user: IUser, payload: IApply) => {
  const { jobId } = payload;

  const job = await jobRepository.findJobById(jobId);
  if (!job) {
    return makeResponse(false, "Job not found!", {}, 404);
  }
  if (job.status !== JobStatus.Active) {
    return makeResponse(
      false,
      `Applications for this job is currently ${job.status}!`
    );
  }

  const aiConfig = await aiConfigRepository.findAIconfigById(
    job.aiConfig as string
  );
  if (!aiConfig) {
    return makeResponse(false, "AI configuration for job not found!", {}, 404);
  }

  //let application = await applicationRepository.findApplicationByMatch({
  //  talent: user._id,
  //  job: jobId,
  //});

  let application: (IApplication & Document) | null =
    await applicationRepository.findApplicationByMatch(
      { talent: user._id, job: jobId }
    );

  if (application) {
    return makeResponse(true, "You have already applied for this job", {
      application,
    });
  }

  if (!(user.profile as IProfile).prescreeningScore) {
    return makeResponse(
      false,
      "You have to take the prescreening test before you can apply for a job"
    );
  }

  if (
    (user.profile as IProfile).prescreeningScore < aiConfig.minPrescreeningScore
  ) {
    return makeResponse(
      false,
      "Sorry your prescreening score is too low to proceed!",
      {},
      403
    );
  }

  application = applicationRepository.createApplication({
    talent: user._id,
    job: jobId,
    applicationType: ApplicationType.Application,
    stages: aiConfig.stages,
    recruiter: (job.postedBy as IUser)._id,
  });

  job.noOfApplicants += 1;
  await job.save();
  if (
    (user.profile as IProfile).prescreeningScore < aiConfig.minPrescreeningScore
  ) {
    application.status = ApplicationStatus.RetakeAssessment;
    await application.save();
    return makeResponse(
      true,
      "Your prescreening score is too low to proceed with application",
      { application }
    );
  }

  application.currentStage = applicationRepository.updateCurrentStage(
    application.currentStage,
    aiConfig.stages
  ).currentStage;
  await application.save();
  application.set("personalizedQuestions", undefined);

  return makeResponse(true, "Application successful", { application });
};
