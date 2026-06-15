import * as applicationRepository from "../../repository/v1/application";
import * as scoutRepository from "../../repository/v1/scout";
import { makeResponse } from "../../helpers/response";
import { IJob } from "../../typings/job";

import { IUser } from "../../typings/user";
import {
  FetchApplications,
  IApplication,
  ScreeningStage,
  TApplicationStatus,
} from "../../typings/application";
import { FilterQuery } from "mongoose";
import { Paging, Roles } from "../../typings/customs";

// Function to get single job Application
export const getApplication = async (user: IUser, applicationId: string) => {
  const application = await applicationRepository.findApplicationById(applicationId);
  if (!application) {
    return makeResponse(false, "Application not found!", {}, 404);
  }

  if (
    (application.job as IJob).postedBy.toString() !== user._id.toString() &&
    (application.talent as IUser)._id.toString() !== user._id.toString()
  ) {
    return makeResponse(false, "You are not authorized to perform this action", {}, 403);
  }

  const count = await applicationRepository.countApplications({
    currentStage: ScreeningStage.Completed,
    job: (application.job as IJob)._id,
  });

  return makeResponse(true, "Job application details fetched", {
    application,
    count,
  });
};

export const getApplications = async (user: IUser, _payload: FetchApplications) => {
  const query: FilterQuery<IApplication> = {};
  if (user.userRole === Roles.Recruiter) {
    query.recruiter = user.id;
  } else if (user.userRole === Roles.Talent) {
    query.talent = user.id;
  }

  const applications = await applicationRepository.findApplicationsByMatch(query);

  return makeResponse(true, "Job application details fetched", {
    application: applications,
  });
};

export const shortlist = async (user: IUser, payload: FetchApplications) => {
  const query: FilterQuery<IApplication> = { recruiter: user.id };
  const paging: Paging = {};
  if (payload.limit) {
    paging.limit = payload.limit;
  }
  if (payload.offset) {
    paging.offset = payload.offset;
  }
  if (payload.sort) {
    paging.sort = payload.sort;
  }

  const campaigns = await applicationRepository.leanApplicationsByMatch(query, paging);

  const scouts = await scoutRepository.findScoutsByMatch(
    query,
    paging,
    "title cvName evaluationScore"
  );

  return makeResponse(true, "Job application details fetched", {
    campaigns,
    scouts,
  });
};

export const updateStatus = async (
  user: IUser,
  payload: { _id: string; status: TApplicationStatus }
) => {
  const application = await applicationRepository.findApplicationById(payload._id);
  if (!application) {
    return makeResponse(false, "Application not found!", {}, 404);
  }

  if (
    (application.job as IJob).postedBy.toString() !== user._id.toString() &&
    (application.talent as IUser)._id.toString() !== user._id.toString()
  ) {
    return makeResponse(false, "You are not authorized to perform this action", {}, 403);
  }
  application.status = payload.status;
  await application.save();

  return makeResponse(true, "Job application status updated", { application });
};
