import { Request, Response } from "express";
import * as messageService from "../services/message.js";
import { sendSuccessResponse } from "../utils/response.js";
import { UserRole } from "../types/enums.js";

export const create = async (req: Request, res: Response) => {
  const result = await messageService.sendMessage(req.user.id, req.body);
  sendSuccessResponse(res, "Message sent", { message: result }, 201);
};

export const broadcastMessage = async (req: Request, res: Response) => {
  await messageService.broadcastMessage(req.user.id, req.body);
  sendSuccessResponse(res, "Broadcast sent");
};

export const acknowledge = async (req: Request, res: Response) => {
  const result = await messageService.acknowledge(req.user.id, {
    id: req.params["id"]!,
    ...req.body,
  });
  sendSuccessResponse(res, "Message acknowledged", { message: result });
};

export const getMessages = async (req: Request, res: Response) => {
  const result = await messageService.getMessages(req.user.id, req.query as Record<string, string>);
  sendSuccessResponse(res, "Messages fetched", result);
};

export const getMessage = async (req: Request, res: Response) => {
  const result = await messageService.getMessage(req.user.id, req.params["id"]!);
  sendSuccessResponse(res, "Message fetched", { message: result });
};

export const getChatSessions = async (req: Request, res: Response) => {
  if (req.user.userRole === UserRole.Talent) {
    const sessions = await messageService.getTalentChatSessions(req.user.id);
    sendSuccessResponse(res, "Chat sessions fetched", { sessions });
    return;
  }
  const sessions = await messageService.getRecruiterChatSessions(req.user.id);
  sendSuccessResponse(res, "Chat sessions fetched", { sessions });
};
