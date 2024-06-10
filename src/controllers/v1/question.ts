import { Response, Request } from "express";
import * as questionController from "../../logics/v1/question";
import { responseHandler } from "../../middlewares/v1/handler";

export const create = async (req: Request, res: Response) => {
  const response = await questionController.createQuestion(req.body);
  return responseHandler(res, response);
};

export const fetchQuestions = async (req: Request, res: Response) => {
  const response = await questionController.fetchQuestions(req.query);
  return responseHandler(res, response);
};

export const fetch = async (req: Request, res: Response) => {
  const response = await questionController.fetchQuestion(req.params as any);
  return responseHandler(res, response);
};

export const answerQuestions = async (req: Request, res: Response) => {
  const response = await questionController.answerQuestions(req.user, req.body);
  return responseHandler(res, response);
};

export const personalizedQuestions = async (req: Request, res: Response) => {
  const response = await questionController.personalizedQuestions(req.body);
  return responseHandler(res, response);
};

export const getPersonalizedQuestions = async (req: Request, res: Response) => {
  const response = await questionController.fetchPersonalizedQuestions(
    req.user,
    req.params._id!
  );
  return responseHandler(res, response);
};

export const personalityQuestion = async (req: Request, res: Response) => {
  const response = await questionController.personalityQuestion(req.body);
  return responseHandler(res, response);
};

export const answerPersonalityQuestions = async (
  req: Request,
  res: Response
) => {
  const response = await questionController.answerPersonalityQuestions(
    req.user,
    req.body
  );
  return responseHandler(res, response);
};
