import { body, param, query } from "express-validator";
import { paginationRules } from "./shared.js";

export const sendMessageValidator = [
  body("application").optional().isString(),
  body("content").notEmpty().withMessage("Message content is required"),
  body("recipient").notEmpty().withMessage("Recipient is required"),
];

export const broadcastMessageValidator = [
  body("application").notEmpty().withMessage("Application ID is required"),
  body("content").optional().isString(),
  body("talentIds").optional().isArray(),
  body("talentIds.*").optional().isString(),
  // Personalized alternative to `content` — one entry per recipient (the AI
  // mass-messaging flow drafts a different message per candidate).
  body("messages").optional().isArray({ min: 1 }).withMessage("messages must be a non-empty array"),
  body("messages.*.applicationId").optional().isString(),
  body("messages.*.content").optional().isString(),
  body("messages.*.subject").optional().isString(),
  body("sendEmail").optional().isBoolean().toBoolean(),
  body().custom((value: { content?: unknown; messages?: unknown[] }) => {
    const hasContent = typeof value.content === "string" && value.content.trim().length > 0;
    const hasMessages = Array.isArray(value.messages) && value.messages.length > 0;
    if (!hasContent && !hasMessages) {
      throw new Error("Provide either content or messages");
    }
    return true;
  }),
];

export const acknowledgeMessageValidator = [
  param("id").notEmpty().withMessage("Message ID is required"),
  body("acknowledge").isBoolean().withMessage("acknowledge must be a boolean"),
];

export const fetchMessagesQueryValidator = [
  query("application").optional().isString(),
  query("conversationId").optional().isString(),
  query("participantId").optional().isString(),
  ...paginationRules,
];

export const messageIdParamValidator = [
  param("id").notEmpty().withMessage("Message ID is required"),
];
