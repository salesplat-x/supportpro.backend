import { Response, Request } from "express";
import * as controller from "../../logics/v1/applications";
import { responseHandler } from "../../middlewares/v1/handler";

export const getApplications = async (req: Request, res: Response) => {
  const response = await controller.getApplications(req.user, req.query);
  return responseHandler(res, response);
};

export const shortlist = async (req: Request, res: Response) => {
  const response = await controller.shortlist(req.user, req.query);
  return responseHandler(res, response);
};

export const getApplication = async (req: Request, res: Response) => {
  const response = await controller.getApplication(req.user, req.params._id!);
  return responseHandler(res, response);
};

export const updateStatus = async (req: Request, res: Response) => {
  const response = await controller.updateStatus(req.user, {
    ...req.params,
    ...req.body,
  });
  return responseHandler(res, response);
};
