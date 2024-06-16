import { Response, Request } from "express";
import * as jobController from "../../logics/v1/job";
import { responseHandler } from "../../middlewares/v1/handler";

export const create = async (req: Request, res: Response) => {
  const response = await jobController.createJob(req.user, req.body);
  return responseHandler(res, response);
};

export const update = async (req: Request, res: Response) => {
  const response = await jobController.updateJob(req.user, {
    ...req.params,
    ...req.body,
  });
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

export const matchJob = async (req: Request, res: Response) => {
  const payload = { ...req.params, ...req.query };
  const response = await jobController.matchJob(req.user, payload as any);
  return responseHandler(res, response);
};

export const topTalents = async (req: Request, res: Response) => {
  const payload = { ...req.params, ...req.query };
  const response = await jobController.topTalents(req.user, payload as any);
  return responseHandler(res, response);
};

export const applications = async (req: Request, res: Response) => {
  const payload = { ...req.params, ...req.query };
  const response = await jobController.applications(req.user, payload as any);
  return responseHandler(res, response);
};
