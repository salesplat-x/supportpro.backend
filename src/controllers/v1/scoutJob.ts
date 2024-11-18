import { Response, Request } from "express";
import * as controller from "../../logics/v1/scoutJob";
import { responseHandler } from "../../middlewares/v1/handler";

export const create = async (req: Request, res: Response) => {
  const response = await controller.createJob(req.user, req.body);
  return responseHandler(res, response);
};

export const update = async (req: Request, res: Response) => {
  const response = await controller.updateJob(req.user, {
    ...req.params,
    ...req.body,
  });
  return responseHandler(res, response);
};

// export const scoutJobsPosted = async (req: Request, res: Response) => {
//   req.query.postedBy = req.user._id as string;
//   const response = await controller.fetchAllscoutJobs(req.query);
//   return responseHandler(res, response);
// };

export const fetch = async (req: Request, res: Response) => {
  const response = await controller.fetchJob(req.params as any);
  return responseHandler(res, response);
};
