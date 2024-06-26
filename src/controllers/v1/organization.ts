import { Response, Request } from "express";
import * as orgLogic from "../../logics/v1/organization";
import { responseHandler } from "../../middlewares/v1/handler";

export const registerOrganization = async (req: Request, res: Response) => {
  const response = await orgLogic.createOrganization(req.body);
  return responseHandler(res, response);
};

// export const update = async (req: Request, res: Response) => {
//   const response = await orgLogic.updateJob(req.user, {
//     ...req.params,
//     ...req.body,
//   });
//   return responseHandler(res, response);
// };

// export const fetchAll = async (req: Request, res: Response) => {
//   const response = await orgLogic.fetchAllJobs(req.query);
//   return responseHandler(res, response);
// };

// export const fetch = async (req: Request, res: Response) => {
//   const response = await orgLogic.fetchJob(req.params as any);
//   return responseHandler(res, response);
// };
