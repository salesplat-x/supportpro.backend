import { Response, Request } from "express";
import * as aiLogic from "../../logics/v1/aiconfig";
import { responseHandler } from "../../middlewares/v1/handler";

export const createAIConfig = async (req: Request, res: Response) => {
  const response = await aiLogic.createAIConfig(req.user, req.body);
  return responseHandler(res, response);
};

export const update = async (req: Request, res: Response) => {
  const response = await aiLogic.updateAIConfig(req.user, {
    ...req.params,
    ...req.body,
  });
  return responseHandler(res, response);
};

export const allAIConfig = async (req: Request, res: Response) => {
  const response = await aiLogic.allAIConfig(req.user);
  return responseHandler(res, response);
};

export const fetchAIConfig = async (req: Request, res: Response) => {
  const response = await aiLogic.fetchAIConfig(req.user, req.params);
  return responseHandler(res, response);
};

export const deleteAIConfig = async (req: Request, res: Response) => {
  const response = await aiLogic.deleteAIConfig(req.user, req.params);
  return responseHandler(res, response);
};
