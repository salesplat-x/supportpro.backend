import { Request, Response } from "express";
import * as adminService from "../services/admin.js";
import * as onboardingService from "../services/onboarding.js";
import { OrganizationStatus } from "../types/enums.js";
import { sendSuccessResponse } from "../utils/response.js";

export const listTalents = async (req: Request, res: Response) => {
  const result = await adminService.listTalents(req.query as Record<string, string>);
  sendSuccessResponse(res, "Talents fetched", result);
};

export const deleteTalent = async (req: Request, res: Response) => {
  await adminService.deleteTalent(req.params["_id"]!);
  sendSuccessResponse(res, "Talent permanently deleted");
};

export const listRecruiters = async (req: Request, res: Response) => {
  const result = await adminService.listRecruiters(req.query as Record<string, string>);
  sendSuccessResponse(res, "Recruiters fetched", result);
};

export const deleteRecruiter = async (req: Request, res: Response) => {
  await adminService.deleteRecruiter(req.params["_id"]!);
  sendSuccessResponse(res, "Recruiter permanently deleted");
};

export const listJobs = async (req: Request, res: Response) => {
  const result = await adminService.listJobs(req.query as Record<string, string>);
  sendSuccessResponse(res, "Jobs fetched", result);
};

export const deleteJob = async (req: Request, res: Response) => {
  await adminService.deleteJobAsAdmin(req.params["_id"]!);
  sendSuccessResponse(res, "Job permanently deleted");
};

export const listOrganizations = async (req: Request, res: Response) => {
  const result = await adminService.listOrganizations(req.query as Record<string, string>);
  sendSuccessResponse(res, "Organizations fetched", result);
};

export const getOrganization = async (req: Request, res: Response) => {
  const result = await adminService.getOrganization(req.params["_id"]!);
  sendSuccessResponse(res, "Organization fetched", { organization: result });
};

export const verifyOrganization = async (req: Request, res: Response) => {
  const result = await adminService.updateOrganizationStatus(
    req.params["_id"]!,
    req.user.id,
    OrganizationStatus.Verified
  );
  sendSuccessResponse(res, "Organization verified", { organization: result });
};

export const rejectOrganization = async (req: Request, res: Response) => {
  const result = await adminService.updateOrganizationStatus(
    req.params["_id"]!,
    req.user.id,
    OrganizationStatus.Rejected
  );
  sendSuccessResponse(res, "Organization rejected", { organization: result });
};

export const deleteOrganization = async (req: Request, res: Response) => {
  await adminService.deleteOrganizationAsAdmin(req.params["_id"]!);
  sendSuccessResponse(res, "Company permanently deleted");
};

export const userOnboarding = async (req: Request, res: Response) => {
  const result = await onboardingService.getUserOnboarding(req.params["_id"]!);
  sendSuccessResponse(res, "Onboarding fetched", { onboarding: result });
};

export const draftOnboardingEmail = async (req: Request, res: Response) => {
  const result = await onboardingService.draftOnboardingEmail(req.params["_id"]!);
  sendSuccessResponse(res, "Email drafted", { draft: result });
};

export const sendOnboardingEmail = async (req: Request, res: Response) => {
  const result = await onboardingService.sendOnboardingEmail(req.user.id, req.params["_id"]!, {
    subject: req.body.subject,
    body: req.body.body,
    confirm: req.body.confirm === true,
  });
  sendSuccessResponse(res, "Email sent", { email: result }, 201);
};
