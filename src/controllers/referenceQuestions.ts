import { Request, Response } from "express";
import * as referenceQuestions from "../services/referenceQuestions.js";
import { sendSuccessResponse } from "../utils/response.js";

export const list = async (req: Request, res: Response) => {
  const questions = await referenceQuestions.getCompanyQuestions(req.user.id, req.params["_id"]!);
  sendSuccessResponse(res, "Reference questions loaded", { questions });
};

export const save = async (req: Request, res: Response) => {
  const questions = await referenceQuestions.setCompanyQuestions(
    req.user.id,
    req.params["_id"]!,
    req.body.questions
  );
  sendSuccessResponse(res, "Reference questions saved", { questions });
};

export const generate = async (req: Request, res: Response) => {
  const questions = await referenceQuestions.generateCompanyQuestions(
    req.user.id,
    req.params["_id"]!,
    req.body.count
  );
  sendSuccessResponse(res, "Reference questions written", { questions });
};

export const jobs = async (req: Request, res: Response) => {
  const jobs = await referenceQuestions.listJobsWithWaitingReferees(
    req.user.id,
    req.params["_id"]!
  );
  sendSuccessResponse(res, "Jobs with waiting referees loaded", { jobs });
};

export const send = async (req: Request, res: Response) => {
  const result = await referenceQuestions.sendQuestionsToJobs(
    req.user.id,
    req.params["_id"]!,
    req.body.jobIds
  );
  sendSuccessResponse(res, "Reference questions sent", result);
};
