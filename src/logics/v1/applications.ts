import * as applicationRepository from "../../repository/v1/application";
import * as scoutRepository from "../../repository/v1/scout";
import { makeResponse } from "../../helpers/response";
import { IJob } from "../../typings/job";

import { IUser } from "../../typings/user";
import {
  ApplicationStatus,
  FetchApplications,
  IApplication,
  TApplicationStatus,
} from "../../typings/application";
import { FilterQuery } from "mongoose";

// Function to get single job Application
export const getApplication = async (user: IUser, applicationId: string) => {
  const application = await applicationRepository.findApplicationById(
    applicationId
  );
  if (!application) {
    return makeResponse(false, "Application not found!", {}, 404);
  }

  if (
    (application.job as IJob).postedBy.toString() !== user._id.toString() &&
    (application.talent as IUser)._id.toString() !== user._id.toString()
  ) {
    return makeResponse(
      false,
      "You are not authorized to perform this action",
      {},
      403
    );
  }

  return makeResponse(true, "Job application details fetched", { application });
};

export const getApplications = async (
  user: IUser,
  payload: FetchApplications
) => {
  const query: FilterQuery<IApplication> = { recruiter: user.id };

  const applications = await applicationRepository.findApplicationsByMatch(
    query
  );

  return makeResponse(true, "Job application details fetched", {
    application: applications,
  });
};

export const shortlist = async (user: IUser, payload: FetchApplications) => {
  const query: FilterQuery<IApplication> = { recruiter: user.id };

  const campaigns = await applicationRepository.findApplicationsByMatch(query);

  const scouts = await scoutRepository.findScoutsByMatch(query);

  return makeResponse(true, "Job application details fetched", {
    campaigns,
    scouts,
  });
};

export const updateStatus = async (
  user: IUser,
  payload: { _id: string; status: TApplicationStatus }
) => {
  const application = await applicationRepository.findApplicationById(
    payload._id
  );
  if (!application) {
    return makeResponse(false, "Application not found!", {}, 404);
  }

  if (
    (application.job as IJob).postedBy.toString() !== user._id.toString() &&
    (application.talent as IUser)._id.toString() !== user._id.toString()
  ) {
    return makeResponse(
      false,
      "You are not authorized to perform this action",
      {},
      403
    );
  }
  application.status = payload.status;
  await application.save();

  return makeResponse(true, "Job application status updated", { application });
};
