import { Response, Request } from "express";
import * as logic from "../../logics/v1/scout";
import { responseHandler } from "../../middlewares/v1/handler";

export const scoutTalents = async (req: Request, res: Response) => {
  const response = await logic.scoutTalents({ ...req.params, ...req.query });
  return responseHandler(res, response);
};

export const fetchScoutReports = async (req: Request, res: Response) => {
  const response = await logic.fetchScoutReports(req.user, req.params.id);
  return responseHandler(res, response);
};

export const fetchScoutReport = async (req: Request, res: Response) => {
  const response = await logic.fetchScoutReport(req.user, req.params.id);
  return responseHandler(res, response);
};

export const scoutCvAndCl = async (req: Request, res: Response) => {
  const response = await logic.scoutCvAndCl(req.user, {
    ...req.body,
    files: req.files,
  });
  return responseHandler(res, response);
};

export const scoutCv = async (req: Request, res: Response) => {
  const response = await logic.scoutCv(req.user, {
    ...req.body,
    file: req.file,
  });
  return responseHandler(res, response);
};
