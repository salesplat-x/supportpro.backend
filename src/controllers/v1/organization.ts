import { Response, Request } from "express";
import * as orgController from "../../logics/v1/organization";
import { responseHandler } from "../../middlewares/v1/handler";

// export const create = async (req: Request, res: Response) => {
//   const response = await orgController.createJob(req.user, req.body);
//   return responseHandler(res, response);
// };

// export const update = async (req: Request, res: Response) => {
//   const response = await orgController.updateJob(req.user, {
//     ...req.params,
//     ...req.body,
//   });
//   return responseHandler(res, response);
// };

// export const fetchAll = async (req: Request, res: Response) => {
//   const response = await orgController.fetchAllJobs(req.query);
//   return responseHandler(res, response);
// };

// export const fetch = async (req: Request, res: Response) => {
//   const response = await orgController.fetchJob(req.params as any);
//   return responseHandler(res, response);
// };

export const setAIConfig = async (req: Request, res: Response) => {
  const response = await orgController.setAIConfig(req.user, req.body);
  return responseHandler(res, response);
};

export const getAIConfig = async (req: Request, res: Response) => {
  const response = await orgController.getAIConfig(req.user);
  return responseHandler(res, response);
};
