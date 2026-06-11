import { Response, Request } from "express";
import * as conversationController from "../../logics/v1/conversation";
import { responseHandler } from "../../middlewares/v1/handler";

export const conversationMessages = async (req: Request, res: Response) => {
  const response = await conversationController.conversationMessages(req.user, req.params.id!);
  return responseHandler(res, response);
};

export const getConversations = async (req: Request, res: Response) => {
  const response = await conversationController.getConversations(req.user);
  return responseHandler(res, response);
};

export const getConversation = async (req: Request, res: Response) => {
  const response = await conversationController.getConversation(req.user, req.params.id!);
  return responseHandler(res, response);
};
