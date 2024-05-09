import { Response, Request } from "express";
import * as jobController from "../../logics/v1/job";
import { responseHandler } from "../../middlewares/v1/handler";

export const create = async (req: Request, res: Response) => {
  const response = await jobController.createJob(req.body);
  return responseHandler(res, response);
};

export const fetchAll = async (req: Request, res: Response) => {
  const response = await jobController.fetchAllJobs(req.query);
  return responseHandler(res, response);
};

export const fetch = async (req: Request, res: Response) => {
  const response = await jobController.fetchJob(req.params as any);
  return responseHandler(res, response);
};

export const fuzzyMatch = async (req: Request, res: Response) => {
  const response = await jobController.fuzzyMatch(req.params as any);
  return responseHandler(res, response);
};
