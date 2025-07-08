import { Response, Request } from "express";
import * as conversationController from "../../logics/v1/conversation";
import { responseHandler } from "../../middlewares/v1/handler";
import { sendSuccessResponse, sendErrorResponse } from "../../helpers/response";
import { chatGPT } from "../../services/v1/openai";

export const conversationMessages = async (req: Request, res: Response) => {
  const response = await conversationController.conversationMessages(
    req.user,
    req.params.id!
  );
  return responseHandler(res, response);
};

export const getConversations = async (req: Request, res: Response) => {
  const response = await conversationController.getConversations(req.user);
  return responseHandler(res, response);
};

export const getConversation = async (req: Request, res: Response) => {
  const response = await conversationController.getConversation(
    req.user,
    req.params.id!
  );
  return responseHandler(res, response);
};

/**
 * POST /v1/conversations
 * Body: { message: string }
 * Returns: { reply: string }
 */
export const sendMessage = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    const { message } = req.body;
    if (typeof message !== "string" || !message.trim()) {
      return sendErrorResponse(res, "No message provided", {}, 400);
    }

    let aiReply: string;
    try {
      aiReply = await chatGPT(message, "text");
    } catch (apiErr: any) {
      console.error("chatGPT failed:", apiErr);
      aiReply = "Sorry, I’m having trouble right now. Please try again later.";
    }

    return sendSuccessResponse(res, "Message processed", { reply: aiReply });
  } catch (err: any) {
    console.error("sendMessage error:", err);
    return sendErrorResponse(res, err.message || "Chat failed", {}, 500);
  }
};