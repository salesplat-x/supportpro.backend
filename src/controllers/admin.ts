import * as aiModelsService from "../services/aiModels.js";
import { Request, Response } from "express";
import * as adminService from "../services/admin.js";
import { DEFAULT_OVERVIEW_DAYS, getAdminOverview } from "../services/adminOverview.js";
import * as onboardingService from "../services/onboarding.js";
import * as applicationFollowUpService from "../services/applicationFollowUps.js";
import { OrganizationStatus } from "../types/enums.js";
import { sendSuccessResponse } from "../utils/response.js";

export const overview = async (req: Request, res: Response) => {
  const days = Number(req.query["days"]) || DEFAULT_OVERVIEW_DAYS;
  const result = await getAdminOverview(days);
  sendSuccessResponse(res, "Overview fetched", result);
};

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

export const listStuckApplications = async (req: Request, res: Response) => {
  const result = await applicationFollowUpService.listStuckApplications(
    req.query as Record<string, string>
  );
  sendSuccessResponse(res, "Stuck applications fetched", result);
};

export const talentStuckApplications = async (req: Request, res: Response) => {
  const result = await applicationFollowUpService.talentStuckApplications(req.params["_id"]!);
  sendSuccessResponse(res, "Stuck applications fetched", { applications: result });
};

export const applicationFollowUp = async (req: Request, res: Response) => {
  const result = await applicationFollowUpService.getApplicationFollowUp(req.params["_id"]!);
  sendSuccessResponse(res, "Application follow-up fetched", { followUp: result });
};

export const draftApplicationFollowUpEmail = async (req: Request, res: Response) => {
  const result = await applicationFollowUpService.draftApplicationFollowUpEmail(req.params["_id"]!);
  sendSuccessResponse(res, "Email drafted", { draft: result });
};

export const sendApplicationFollowUpEmail = async (req: Request, res: Response) => {
  const result = await applicationFollowUpService.sendApplicationFollowUpEmail(
    req.user.id,
    req.params["_id"]!,
    {
      subject: req.body.subject,
      body: req.body.body,
      confirm: req.body.confirm === true,
    }
  );
  sendSuccessResponse(res, "Email sent", { email: result }, 201);
};

export const getAiModels = async (_req: Request, res: Response) => {
  const result = await aiModelsService.getAiModelsOverview();
  sendSuccessResponse(res, "AI models fetched", result);
};

export const updateAiFeatureModel = async (req: Request, res: Response) => {
  const { provider, model } = req.body as { provider: string; model: string };
  const feature = await aiModelsService.updateAiFeatureModel(req.user.id, req.params["key"]!, {
    provider,
    model,
  });
  sendSuccessResponse(res, "AI model saved", { feature });
};

export const getAiFeaturePrompts = async (req: Request, res: Response) => {
  const prompts = await aiModelsService.getAiFeaturePrompts(req.params["key"]!);
  sendSuccessResponse(res, "AI prompts fetched", { prompts });
};

export const updateAiFeaturePrompts = async (req: Request, res: Response) => {
  const { prompts: edits } = req.body as { prompts: Record<string, string> };
  const prompts = await aiModelsService.updateAiFeaturePrompts(
    req.user.id,
    req.params["key"]!,
    edits
  );
  sendSuccessResponse(res, "AI prompts saved", { prompts });
};
