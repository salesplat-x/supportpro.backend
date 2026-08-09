import { Request, Response } from "express";
import * as userService from "../services/user.js";
import { sendSuccessResponse } from "../utils/response.js";

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
  sendSuccessResponse(res, "Profile updated", { user: withoutCvText(result) });
};

export const me = async (req: Request, res: Response) => {
  const result = await userService.me(req.user.id);
  const profileCompletion = userService.getProfileCompletion(result);
  sendSuccessResponse(res, "User fetched", {
    user: { ...withoutCvText(result), profileCompletion },
  });
};

export const viewProfiles = async (req: Request, res: Response) => {
  const result = await userService.viewProfilesForRole(req.query as Record<string, string>);
  sendSuccessResponse(res, "Profiles fetched", { users: result });
};

export const viewProfile = async (req: Request, res: Response) => {
  const result = await userService.viewProfile(req.params["_id"]!);
  sendSuccessResponse(res, "Profile fetched", { user: result });
};

export const downloadTalentCv = async (req: Request, res: Response) => {
  const { buffer, fileName } = await userService.getTalentCvPdf(req.params["_id"]!);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
  res.setHeader("Content-Length", String(buffer.length));
  res.send(buffer);
};

export const applications = async (req: Request, res: Response) => {
  const result = await userService.userApplications(
    req.user.id,
    req.query as Record<string, string>
  );
  sendSuccessResponse(res, "Applications fetched", { applications: result });
};
