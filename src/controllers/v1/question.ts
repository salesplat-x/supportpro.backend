import { Response, Request } from "express";
import * as questionController from "../../logics/v1/question";
import { responseHandler } from "../../middlewares/v1/handler";

export const create = async (req: Request, res: Response) => {
  const response = await questionController.createQuestion(req.body);
  return responseHandler(res, response);
};

export const fetchQuestions = async (req: Request, res: Response) => {
  const response = await questionController.fetchQuestions(req.user, req.query);
  return responseHandler(res, response);
};

export const fetch = async (req: Request, res: Response) => {
  const response = await questionController.fetchQuestion(req.params as any);
  return responseHandler(res, response);
};

export const answerPrescreening = async (req: Request, res: Response) => {
  const response = await questionController.answerPrescreening(
    req.user,
    req.body
  );
  return responseHandler(res, response);
};

export const generatePersonalizedQuestions = async (
  req: Request,
  res: Response
) => {
  const response = await questionController.generatePersonalizedQuestions(
    req.body
  );
  return responseHandler(res, response);
};

export const answerPersonalizedQuestions = async (
  req: Request,
  res: Response
) => {
  const response = await questionController.answerPersonalizedQuestions(
    req.user,
    req.body
  );
  return responseHandler(res, response);
};

export const generatePersonalityQuestion = async (
  req: Request,
  res: Response
) => {
  const response = await questionController.generatePersonalityQuestion(
    req.body
  );
  return responseHandler(res, response);
};

export const evaluatePersonalityType = async (req: Request, res: Response) => {
  const response = await questionController.evaluatePersonalityType(
    req.user,
    req.body
  );
  return responseHandler(res, response);
};
