import { Request, Response } from "express";
import * as feedbackService from "../services/feedback.js";
import { draftSupportReplyNow } from "../services/supportAi.js";
import { buildSupportContext } from "../services/supportContext.js";
import { sendSuccessResponse } from "../utils/response.js";

export const submitFeedback = async (req: Request, res: Response) => {
  const { request, created } = await feedbackService.submitFeedback(req.user.id, req.body);
  sendSuccessResponse(
    res,
    created ? "Message sent" : "Message already sent",
    { request },
    created ? 201 : 200
  );
};

export const listMine = async (req: Request, res: Response) => {
  const requests = await feedbackService.listMySupport(req.user.id);
  sendSuccessResponse(res, "Support conversation fetched", { requests });
};

export const getFeedback = async (req: Request, res: Response) => {
  const result = await feedbackService.listSupportInbox(
    req.query as feedbackService.SupportInboxFilters
  );
  sendSuccessResponse(res, "Support requests fetched", result);
};

export const getRequest = async (req: Request, res: Response) => {
  const result = await feedbackService.getSupportRequest(req.params["id"]!);
  sendSuccessResponse(res, "Support request fetched", result);
};

export const getUserContext = async (req: Request, res: Response) => {
  const userId = await feedbackService.supportRequestUserId(req.params["id"]!);
  const context = await buildSupportContext(userId);
  sendSuccessResponse(res, "User context fetched", { context });
};

export const markRead = async (req: Request, res: Response) => {
  const request = await feedbackService.markSupportRead(req.params["id"]!);
  sendSuccessResponse(res, "Marked as read", { request });
};

export const markUnread = async (req: Request, res: Response) => {
  const request = await feedbackService.markSupportUnread(req.params["id"]!);
  sendSuccessResponse(res, "Marked as unread", { request });
};

export const saveDraft = async (req: Request, res: Response) => {
  const draft = await feedbackService.saveSupportDraft(
    req.params["id"]!,
    (req.body as { draft: string }).draft
  );
  sendSuccessResponse(res, "Draft saved", draft);
};

export const reply = async (req: Request, res: Response) => {
  const request = await feedbackService.replyToSupportRequest(
    req.user.id,
    req.params["id"]!,
    (req.body as { reply: string }).reply
  );
  sendSuccessResponse(res, "Reply sent", { request });
};

export const retryReplyEmail = async (req: Request, res: Response) => {
  const request = await feedbackService.retrySupportReplyEmail(req.params["id"]!);
  sendSuccessResponse(res, "Email retried", { request });
};

export const draftWithAi = async (req: Request, res: Response) => {
  await draftSupportReplyNow(req.params["id"]!);
  const request = await feedbackService.loadSupportRequest(req.params["id"]!);
  sendSuccessResponse(res, "Draft written", { request });
};
