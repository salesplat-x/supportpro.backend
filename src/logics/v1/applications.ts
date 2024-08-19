import * as applicationRepository from "../../repository/v1/application";
import { makeResponse } from "../../helpers/response";
import { IJob } from "../../typings/job";

import { IUser } from "../../typings/user";

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
