import { Request, Response } from "express";
import * as feedbackService from "../services/feedback.js";
import { sendSuccessResponse } from "../utils/response.js";

export const submitFeedback = async (req: Request, res: Response) => {
  const result = await feedbackService.submitFeedback(req.user.id, req.body);
  sendSuccessResponse(res, "Feedback submitted", { feedback: result }, 201);
};

export const getFeedback = async (req: Request, res: Response) => {
  const result = await feedbackService.listFeedback(req.query as Record<string, string>);
  sendSuccessResponse(res, "Feedback fetched", result);
};

export const markRead = async (req: Request, res: Response) => {
  const result = await feedbackService.markFeedbackRead(req.params["id"]!);
  sendSuccessResponse(res, "Feedback marked as read", { feedback: result });
};

export const markUnread = async (req: Request, res: Response) => {
  const result = await feedbackService.markFeedbackUnread(req.params["id"]!);
  sendSuccessResponse(res, "Feedback marked as unread", { feedback: result });
};
