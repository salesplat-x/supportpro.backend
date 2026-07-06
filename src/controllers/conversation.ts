import { Request, Response } from "express";
import * as conversationService from "../services/conversation.js";
import { sendSuccessResponse } from "../utils/response.js";

export const conversationMessages = async (req: Request, res: Response) => {
  const result = await conversationService.conversationMessages(req.user.id, req.params["id"]!);
  sendSuccessResponse(res, "Messages fetched", result);
};

export const getConversations = async (req: Request, res: Response) => {
  const result = await conversationService.getConversations(req.user.id);
  sendSuccessResponse(res, "Conversations fetched", { conversations: result });
};

export const getConversation = async (req: Request, res: Response) => {
  const result = await conversationService.getConversation(req.user.id, req.params["id"]!);
  sendSuccessResponse(res, "Conversation fetched", { conversation: result });
};
