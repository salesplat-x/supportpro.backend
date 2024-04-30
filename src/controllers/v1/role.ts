import { Response, Request } from "express";
import * as roleController from "../../logics/v1/role";
import { responseHandler } from "../../middlewares/v1/handler";

export const create = async (req: Request, res: Response) => {
  const response = await roleController.createRole(req.body);
  return responseHandler(res, response);
};

export const fetchAll = async (req: Request, res: Response) => {
  const response = await roleController.fetchAllRoles();
  return responseHandler(res, response);
};

export const fetch = async (req: Request, res: Response) => {
  const response = await roleController.fetchRole(req.params as any);
  return responseHandler(res, response);
};

export const questions = async (req: Request, res: Response) => {
  const response = await roleController.questions(req.params as any);
  return responseHandler(res, response);
};
