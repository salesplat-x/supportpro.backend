import { Request, Response } from "express";
import * as prescreeningLogic from "../../logics/v1/prescreening";
import { responseHandler } from "../../middlewares/v1/handler";

export const getPreScreening = async (req: Request, res: Response) => {
  const response = await prescreeningLogic.getActivePreScreening(req.user);
  return responseHandler(res, response);
};

export const submitAnswers = async (req: Request, res: Response) => {
  const response = await prescreeningLogic.submitPreScreeningAnswers(req.user, req.body.answers);
  return responseHandler(res, response);
};

export const requestRetake = async (req: Request, res: Response) => {
  const response = await prescreeningLogic.retakePreScreening(req.user);
  return responseHandler(res, response);
};
