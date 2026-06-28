import { body, param, query } from "express-validator";
import { paginationRules } from "./shared.js";

export const sendMessageValidator = [
  body("application").optional().isString(),
  body("content").notEmpty().withMessage("Message content is required"),
  body("recipient").notEmpty().withMessage("Recipient is required"),
];

export const broadcastMessageValidator = [
  body("application").notEmpty().withMessage("Application ID is required"),
  body("content").notEmpty().withMessage("Message content is required"),
];

export const acknowledgeMessageValidator = [
  param("id").notEmpty().withMessage("Message ID is required"),
  body("acknowledge").isBoolean().withMessage("acknowledge must be a boolean"),
];

export const fetchMessagesQueryValidator = [
  query("application").optional().isString(),
  query("conversationId").optional().isString(),
  ...paginationRules,
];

export const messageIdParamValidator = [param("id").notEmpty().withMessage("Message ID is required")];
