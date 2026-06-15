import { Response, Request } from "express";
import * as userController from "../../logics/v1/user";
import * as profileController from "../../logics/v1/profile";
import { responseHandler } from "../../middlewares/v1/handler";

export const updateUser = async (req: Request, res: Response) => {
  const response = await userController.updateUser(req.user, req.body);
  return responseHandler(res, response);
};

export const editProfile = async (req: Request, res: Response) => {
  const response = await userController.editProfile(req.body, req.user, req.file);
  return responseHandler(res, response);
};

export const me = async (req: Request, res: Response) => {
  const response = await userController.me(req.user);
  return responseHandler(res, response);
};

export const viewProfiles = async (req: Request, res: Response) => {
  const response = await userController.viewProfilesForRole(req.query);
  return responseHandler(res, response);
};

export const viewProfile = async (req: Request, res: Response) => {
  const response = await userController.viewProfile(req.params as any);
  return responseHandler(res, response);
};

export const applications = async (req: Request, res: Response) => {
  const response = await userController.applications(req.user, req.query);
  return responseHandler(res, response);
};

export const uploadProfileImage = async (req: Request, res: Response) => {
  const response = await profileController.uploadProfileImage(req.user, req.file);
  return responseHandler(res, response);
};
