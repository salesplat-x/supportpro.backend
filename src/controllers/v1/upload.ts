import { Response, Request } from "express";
import * as uploadLogic from "../../logics/v1/upload";
import { responseHandler } from "../../middlewares/v1/handler";

export const uploadLocal = async (req: Request, res: Response) => {
  const response = await uploadLogic.uploadLocal(req);
  return responseHandler(res, response);
};

export const uploadCloudinary = async (req: Request, res: Response) => {
  const response = await uploadLogic.uploadCloudinary(req);
  return responseHandler(res, response);
};
