import { Response, Request } from "express";
import * as logic from "../../logics/v1/cvBathcing";
import { responseHandler } from "../../middlewares/v1/handler";

export const cvAndCoverLetter = async (req: Request, res: Response) => {
  const response = await logic.cvAndCoverLetter(req);
  return responseHandler(res, response);
};
