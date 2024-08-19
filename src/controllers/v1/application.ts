import { Response, Request } from "express";
import * as controller from "../../logics/v1/applications";
import { responseHandler } from "../../middlewares/v1/handler";

export const getApplication = async (req: Request, res: Response) => {
  const response = await controller.getApplication(req.user, req.params._id!);
  return responseHandler(res, response);
};
