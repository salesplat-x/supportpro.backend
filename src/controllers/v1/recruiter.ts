import { Response, Request } from "express";
import * as recruiterController from "../../logics/v1/recruiter";
import { responseHandler } from "../../middlewares/v1/handler";
import { ApplicationType } from "../../typings/application";

export const recruiterDashboard = async (req: Request, res: Response) => {
  const response = await recruiterController.recruiterDashboard(req);
  return responseHandler(res, response);
};

export const recentApplications = async (req: Request, res: Response) => {
  req.query.applicationType = ApplicationType.Application;
  const response = await recruiterController.applications(req.user, req.query);
  return responseHandler(res, response);
};

export const recentCompilations = async (req: Request, res: Response) => {
  const response = await recruiterController.applications(req.user, req.query);
  return responseHandler(res, response);
};
