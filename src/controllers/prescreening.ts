import { Request, Response } from "express";
import * as prescreeningService from "../services/prescreening.js";
import { sendSuccessResponse } from "../utils/response.js";

export const getPreScreening = async (req: Request, res: Response) => {
  const result = await prescreeningService.getActivePreScreening(req.user.id);
  sendSuccessResponse(res, "Prescreening fetched", result);
};

export const submitAnswers = async (req: Request, res: Response) => {
  const result = await prescreeningService.submitPreScreeningAnswers(req.user.id, req.body.answers);
  sendSuccessResponse(res, "Prescreening submitted", result);
};

export const requestRetake = async (req: Request, res: Response) => {
  const result = await prescreeningService.retakePreScreening(req.user.id);
  sendSuccessResponse(res, "Prescreening retake requested", result);
};
