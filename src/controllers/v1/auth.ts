import { Response, Request } from "express";
import * as authController from "../../logics/v1/auth";
import { responseHandler } from "../../middlewares/v1/handler";
import { Roles } from "../../typings/customs";

export const register = async (req: Request, res: Response) => {
  const response = await authController.createUser(req.body, req.ip);
  return responseHandler(res, response);
};

export const registerRecruiter = async (req: Request, res: Response) => {
  req.body.userRole = Roles.Recruiter;
  const response = await authController.createUser(req.body, req.ip);
  return responseHandler(res, response);
};

export const login = async (req: Request, res: Response) => {
  const response = await authController.loginUser(req.body, req.ip);
  return responseHandler(res, response);
};

export const forgotPassword = async (req: Request, res: Response) => {
  const response = await authController.forgotPassword(req.body, req.ip);
  return responseHandler(res, response);
};

export const resetPassword = async (req: Request, res: Response) => {
  const response = await authController.resetPassword(req.body, req.ip);
  return responseHandler(res, response);
};

export const changePassword = async (req: Request, res: Response) => {
  const response = await authController.changePassword(req.user, req.body, req.ip);
  return responseHandler(res, response);
};

export const logout = async (req: Request, res: Response) => {
  const response = await authController.logout(req.user, req.ip);
  return responseHandler(res, response);
};
