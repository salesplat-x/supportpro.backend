import { Request, Response } from "express";
import * as userService from "../services/user.js";
import { sendSuccessResponse } from "../utils/response.js";

export const updateUser = async (req: Request, res: Response) => {
  const result = await userService.updateUser(req.user.id, req.body);
  sendSuccessResponse(res, "Profile updated", { user: result });
};

export const editProfile = async (req: Request, res: Response) => {
  const result = await userService.editProfile(req.user.id, req.body, req.file);
  sendSuccessResponse(res, "Profile updated", { user: result });
};

export const me = async (req: Request, res: Response) => {
  const result = await userService.me(req.user.id);
  sendSuccessResponse(res, "User fetched", { user: result });
};

export const viewProfiles = async (req: Request, res: Response) => {
  const result = await userService.viewProfilesForRole(req.query as Record<string, string>);
  sendSuccessResponse(res, "Profiles fetched", { users: result });
};

export const viewProfile = async (req: Request, res: Response) => {
  const result = await userService.viewProfile(req.params["_id"]!);
  sendSuccessResponse(res, "Profile fetched", { user: result });
};

export const applications = async (req: Request, res: Response) => {
  const result = await userService.userApplications(
    req.user.id,
    req.query as Record<string, string>
  );
  sendSuccessResponse(res, "Applications fetched", result);
};

export const uploadProfileImage = async (req: Request, res: Response) => {
  const result = await userService.uploadProfileImage(req.user.id, req.file);
  sendSuccessResponse(res, "Profile image updated", { user: result });
};
