import { Request, Response } from "express";
import * as onboardingService from "../services/onboarding.js";
import * as userService from "../services/user.js";
import { getTalentDashboard } from "../services/talentDashboard.js";
import { sendSuccessResponse } from "../utils/response.js";
import { hideAssessmentResultsFromCandidate } from "../services/application.js";

const withoutCvText = <T extends object>(user: T): Omit<T, "cvText"> => {
  const { cvText: _cvText, ...rest } = user as T & { cvText?: unknown };
  return rest;
};

export const updateUser = async (req: Request, res: Response) => {
  const result = await userService.updateUser(req.user.id, req.body);
  sendSuccessResponse(res, "Profile updated", { user: withoutCvText(result) });
};

export const editProfile = async (req: Request, res: Response) => {
  const result = await userService.editProfile(req.user.id, req.body, req.file);
  const cvReading = await userService.loadCvReading(req.user.id);
  sendSuccessResponse(res, "Profile updated", {
    user: { ...withoutCvText(result), ...cvReading },
  });
};

export const updateAvatar = async (req: Request, res: Response) => {
  const result = await userService.updateAvatar(req.user.id, req.file);
  sendSuccessResponse(res, "Profile picture updated", { user: withoutCvText(result) });
};

export const removeAvatar = async (req: Request, res: Response) => {
  const result = await userService.removeAvatar(req.user.id);
  sendSuccessResponse(res, "Profile picture removed", { user: withoutCvText(result) });
};

export const myOnboarding = async (req: Request, res: Response) => {
  const onboarding = await onboardingService.getMyOnboarding(req.user.id);
  sendSuccessResponse(res, "Onboarding fetched", { onboarding });
};

export const me = async (req: Request, res: Response) => {
  const result = await userService.me(req.user.id);
  const profileCompletion = userService.getProfileCompletion(result);
  const [cvReading, hasJoinedStaff] = await Promise.all([
    userService.loadCvReading(req.user.id),
    userService.hasJoinedStaff(req.user.id),
  ]);
  sendSuccessResponse(res, "User fetched", {
    user: { ...withoutCvText(result), ...cvReading, profileCompletion, hasJoinedStaff },
  });
};

export const viewProfiles = async (req: Request, res: Response) => {
  const result = await userService.viewProfilesForRole(req.query as Record<string, string>);
  sendSuccessResponse(res, "Profiles fetched", { users: result });
};

export const viewProfile = async (req: Request, res: Response) => {
  const result = await userService.viewProfile(req.params["_id"]!, req.user);
  sendSuccessResponse(res, "Profile fetched", { user: result });
};

export const downloadTalentCv = async (req: Request, res: Response) => {
  const file = await userService.getTalentCvFile(req.params["_id"]!, {
    id: req.user.id,
    userRole: req.user.userRole,
  });
  if (file.type === "redirect") {
    res.redirect(302, file.url);
    return;
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${file.fileName}"`);
  res.setHeader("Content-Length", String(file.buffer.length));
  res.send(file.buffer);
};

export const reprocessCv = async (req: Request, res: Response) => {
  await userService.reprocessCv(req.user.id, req.params["_id"]!);
  sendSuccessResponse(res, "CV re-analyzed", {});
};

export const dashboard = async (req: Request, res: Response) => {
  const result = await getTalentDashboard(req.user.id);
  sendSuccessResponse(res, "Dashboard fetched", result);
};

export const applications = async (req: Request, res: Response) => {
  const result = await userService.userApplications(
    req.user.id,
    req.query as Record<string, string>
  );
  result.applications.forEach(hideAssessmentResultsFromCandidate);
  sendSuccessResponse(res, "Applications fetched", result);
};

export const applicationPipeline = async (req: Request, res: Response) => {
  const pipeline = await userService.talentApplicationPipeline(
    req.user.id,
    req.params["applicationId"]!
  );
  sendSuccessResponse(res, "Application pipeline fetched", pipeline);
};
