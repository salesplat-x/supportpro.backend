import { Request, Response } from "express";
import { UserRole } from "../types/enums.js";
import * as authService from "../services/auth.js";
import { sendSuccessResponse } from "../utils/response.js";

export const register = async (req: Request, res: Response) => {
  const result = await authService.createUser(req.body, UserRole.Talent, req.ip ?? undefined);
  sendSuccessResponse(
    res,
    "User Registered Successfully",
    { user: result.user, token: result.token },
    201
  );
};

export const registerRecruiter = async (req: Request, res: Response) => {
  const result = await authService.createUser(req.body, UserRole.Recruiter, req.ip ?? undefined);
  sendSuccessResponse(
    res,
    "User Registered Successfully",
    { user: result.user, token: result.token },
    201
  );
};

export const login = async (req: Request, res: Response) => {
  const result = await authService.loginUser(req.body, req.ip ?? undefined);
  sendSuccessResponse(res, "Login successful", { user: result.user, token: result.token });
};

export const forgotPassword = async (req: Request, res: Response) => {
  await authService.forgotPassword(req.body, req.ip ?? undefined);
  sendSuccessResponse(res, "If an account exists for this email, a reset code has been sent.");
};

export const resetPassword = async (req: Request, res: Response) => {
  await authService.resetPassword(req.body, req.ip ?? undefined);
  sendSuccessResponse(res, "Password has been reset");
};

export const changePassword = async (req: Request, res: Response) => {
  const result = await authService.changePassword(req.user.id, req.body, req.ip ?? undefined);
  sendSuccessResponse(res, "Password changed", { user: result.user, token: result.token });
};

export const logout = async (req: Request, res: Response) => {
  await authService.logout(req.user.id, req.ip ?? undefined);
  sendSuccessResponse(res, "Logged out successfully");
};
