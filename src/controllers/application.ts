import { Request, Response } from "express";
import * as applicationService from "../services/application.js";
import { sendSuccessResponse } from "../utils/response.js";

export const getApplications = async (req: Request, res: Response) => {
  const result = await applicationService.getApplications(
    req.user.id,
    req.user.userRole,
    req.query as Record<string, string>
  );
  sendSuccessResponse(res, "Applications fetched", result);
};

export const shortlist = async (req: Request, res: Response) => {
  const result = await applicationService.shortlist(
    req.user.id,
    req.query as Record<string, string>
  );
  sendSuccessResponse(res, "Shortlisted applications fetched", result);
};

export const getApplication = async (req: Request, res: Response) => {
  const result = await applicationService.getApplication(req.user.id, req.params["_id"]!);
  sendSuccessResponse(res, "Application fetched", result);
};

export const updateStatus = async (req: Request, res: Response) => {
  const result = await applicationService.updateStatus(req.user.id, {
    id: req.params["_id"]!,
    ...req.body,
  });
  sendSuccessResponse(res, "Application status updated", { application: result });
};
