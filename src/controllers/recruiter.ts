import { Request, Response } from "express";
import * as recruiterService from "../services/recruiter.js";
import {
  APPLICANTS_DEFAULT_LIMIT,
  DEFAULT_SUMMARY_CHART,
  DEFAULT_SUMMARY_DAYS,
  getRecruiterDashboardApplicants,
  getRecruiterDashboardCounts,
  getRecruiterDashboardSummary,
  type SummaryChart,
} from "../services/recruiterDashboardSummary.js";
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

export const dashboardSummary = async (req: Request, res: Response) => {
  const days = Number(req.query["range"]) || DEFAULT_SUMMARY_DAYS;
  const chart = (req.query["chart"] as SummaryChart | undefined) ?? DEFAULT_SUMMARY_CHART;
  const result = await getRecruiterDashboardSummary(req.user.id, days, chart);
  sendSuccessResponse(res, "Dashboard summary fetched", result);
};

export const dashboardApplicants = async (req: Request, res: Response) => {
  const limit = Number(req.query["limit"]) || APPLICANTS_DEFAULT_LIMIT;
  const offset = Number(req.query["offset"]) || 0;
  const result = await getRecruiterDashboardApplicants(req.user.id, limit, offset);
  sendSuccessResponse(res, "Dashboard applicants fetched", result);
};

export const dashboardCounts = async (req: Request, res: Response) => {
  const result = await getRecruiterDashboardCounts(req.user.id);
  sendSuccessResponse(res, "Dashboard counts fetched", result);
};
