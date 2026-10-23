import { Request, Response } from "express";
import * as questionService from "../services/question.js";
import * as answerService from "../services/answer.js";
import { sendSuccessResponse } from "../utils/response.js";

export const create = async (req: Request, res: Response) => {
  const result = await questionService.createQuestion(req.body);
  sendSuccessResponse(res, "Question created", { question: result }, 201);
};

export const fetchQuestions = async (req: Request, res: Response) => {
  const result = await questionService.fetchQuestions(
    req.user,
    req.query as Record<string, string>
  );
  sendSuccessResponse(res, "Questions fetched", { questions: result });
};

export const fetch = async (req: Request, res: Response) => {
  const result = await questionService.fetchQuestion(req.params["_id"]!);
  sendSuccessResponse(res, "Question fetched", { question: result });
};

export const answerPrescreening = async (req: Request, res: Response) => {
  const result = await answerService.answerPrescreening(req.user.id, req.body);
  sendSuccessResponse(res, "Prescreening answers submitted", result);
};

export const generatePersonalizedQuestions = async (req: Request, res: Response) => {
  const result = await questionService.generatePersonalizedQuestions(req.body);
  sendSuccessResponse(res, "Personalized questions generated", result);
};

export const answerPersonalizedQuestions = async (req: Request, res: Response) => {
  const result = await answerService.answerPersonalizedQuestions(req.user.id, req.body);
  sendSuccessResponse(res, "Personalized answers submitted", result);
};

export const generatePersonalityQuestion = async (req: Request, res: Response) => {
  const result = await questionService.generatePersonalityQuestion(req.body);
  sendSuccessResponse(res, "Personality question generated", { questions: result });
};

export const ensurePersonalityQuestions = async (req: Request, res: Response) => {
  const result = await questionService.ensurePersonalityQuestions(req.body.jobId);
  sendSuccessResponse(res, "Personality questions ready", { questions: result });
};

export const generateProblemSolvingQuestions = async (req: Request, res: Response) => {
  const result = await questionService.generateProblemSolvingQuestions(req.user, req.body);
  sendSuccessResponse(res, "Problem-solving questions generated", result);
};

export const generateCultureFitQuestions = async (req: Request, res: Response) => {
  const result = await questionService.generateCultureFitQuestions(req.user, req.body);
  sendSuccessResponse(res, "Culture-fit questions generated", result);
};

export const evaluatePersonalityType = async (req: Request, res: Response) => {
  const result = await answerService.evaluatePersonalityType(req.user.id, req.body);
  sendSuccessResponse(res, "Personality evaluated", result);
};

export const deleteQuestion = async (req: Request, res: Response) => {
  await questionService.deleteQuestion(req.user.id, req.params["_id"]!);
  sendSuccessResponse(res, "Question deleted", {});
};
