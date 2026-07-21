import { Request, Response } from "express";
import * as jobService from "../services/job.js";
import { JobStatus, UserRole } from "../types/enums.js";
import { sendSuccessResponse } from "../utils/response.js";

export const create = async (req: Request, res: Response) => {
  const result = await jobService.createJob(req.user.id, req.body);
  sendSuccessResponse(res, "Job created", { job: result }, 201);
};

export const update = async (req: Request, res: Response) => {
  const result = await jobService.updateJob(req.user.id, req.user.userRole, {
    id: req.params["_id"]!,
    ...req.body,
  });
  sendSuccessResponse(res, "Job updated", { job: result });
};

export const remove = async (req: Request, res: Response) => {
  await jobService.deleteJob(req.user.id, req.params["_id"]!);
  sendSuccessResponse(res, "Job deleted", {});
};

export const fetchAll = async (req: Request, res: Response) => {
  const talentId = req.user?.userRole === UserRole.Talent ? req.user.id : undefined;
  const result = await jobService.fetchAllJobs({
    ...req.query,
    status: JobStatus.Active,
    talentId,
  });
  sendSuccessResponse(res, "Jobs fetched", { jobs: result });
};

export const jobsPosted = async (req: Request, res: Response) => {
  const result = await jobService.fetchAllJobs({ ...req.query, postedBy: req.user.id });
  sendSuccessResponse(res, "Jobs fetched", { jobs: result });
};

export const fetch = async (req: Request, res: Response) => {
  const talentId = req.user?.userRole === UserRole.Talent ? req.user.id : undefined;
  const result = await jobService.fetchJob(req.params["_id"]!, talentId);
  sendSuccessResponse(res, "Job fetched", { job: result });
};

export const matchJob = async (req: Request, res: Response) => {
  const result = await jobService.matchJob(req.user.id, req.user.userRole, {
    id: req.params["_id"]!,
    ...(req.query as Record<string, string>),
  });
  sendSuccessResponse(res, "Talents matched", { talents: result });
};

export const topTalents = async (req: Request, res: Response) => {
  const result = await jobService.topTalents(req.user.id, req.user.userRole, {
    jobId: req.params["jobId"]!,
    percentage: req.query["percentage"] ? Number(req.query["percentage"]) : undefined,
    limit: req.query["limit"] ? Number(req.query["limit"]) : undefined,
  });
  sendSuccessResponse(res, "Top talents fetched", result);
};

export const gradeCv = async (req: Request, res: Response) => {
  const result = await jobService.gradeCv(req.user.id, req.params["jobId"]!);
  sendSuccessResponse(res, "CV graded", result);
};

export const applications = async (req: Request, res: Response) => {
  const result = await jobService.jobApplications(req.user.id, {
    jobId: req.params["jobId"]!,
    ...(req.query as Record<string, string | number>),
  });
  sendSuccessResponse(res, "Applications fetched", { applications: result });
};

export const apply = async (req: Request, res: Response) => {
  const result = await jobService.apply(req.user, { jobId: req.params["jobId"]! });
  sendSuccessResponse(res, "Application submitted", { application: result }, 201);
};

export const checkPrescreening = async (req: Request, res: Response) => {
  const result = await jobService.checkPrescreeningAdvance(req.user.id, req.params["jobId"]!);
  sendSuccessResponse(res, "Prescreening stage checked", { application: result });
};
