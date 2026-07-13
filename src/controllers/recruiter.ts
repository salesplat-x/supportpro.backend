import { Request, Response } from "express";
import * as recruiterService from "../services/recruiter.js";
import { ApplicationType, ApplicationStatus } from "../types/enums.js";
import { sendSuccessResponse } from "../utils/response.js";

export const recruiterDashboard = async (req: Request, res: Response) => {
  const result = await recruiterService.recruiterDashboard(
    req.user.id,
    req.query["jobId"] as string | undefined
  );
  sendSuccessResponse(res, "Dashboard data fetched", { data: result });
};

export const recentApplications = async (req: Request, res: Response) => {
  const result = await recruiterService.recruiterApplications(req.user.id, {
    ...(req.query as Record<string, string>),
    applicationType: ApplicationType.Application,
  });
  sendSuccessResponse(res, "Recent applications fetched", { applications: result });
};

export const shortlistedApplications = async (req: Request, res: Response) => {
  const result = await recruiterService.recruiterApplications(req.user.id, {
    ...(req.query as Record<string, string>),
    applicationType: ApplicationType.Application,
    applicationStatus: ApplicationStatus.Shortlisted,
  });
  sendSuccessResponse(res, "Shortlisted applications fetched", { applications: result });
};

export const recentCompilations = async (req: Request, res: Response) => {
  const result = await recruiterService.recruiterApplications(
    req.user.id,
    req.query as Record<string, string>
  );
  sendSuccessResponse(res, "Recent compilations fetched", { applications: result });
};
