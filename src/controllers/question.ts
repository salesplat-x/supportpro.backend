import { Request, Response } from "express";
import * as questionService from "../services/question.js";
import * as answerService from "../services/answer.js";
import { sendSuccessResponse } from "../utils/response.js";

export const create = async (req: Request, res: Response) => {
  const result = await questionService.createQuestion(req.body);
  sendSuccessResponse(res, "Question created", { question: result }, 201);
};

export const fetchQuestions = async (req: Request, res: Response) => {
  const result = await questionService.fetchQuestions(req.user, req.query as Record<string, string>);
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
  sendSuccessResponse(res, "Personality question generated", { question: result });
};

export const evaluatePersonalityType = async (req: Request, res: Response) => {
  const result = await answerService.evaluatePersonalityType(req.user.id, req.body);
  sendSuccessResponse(res, "Personality evaluated", result);
};
