import { Response, Request } from "express";
import * as uploadLogic from "../../logics/v1/upload";
import { responseHandler } from "../../middlewares/v1/handler";

export const uploadFile = async (req: Request, res: Response) => {
  const response = await uploadLogic.uploadFile(req);
  return responseHandler(res, response);
};
