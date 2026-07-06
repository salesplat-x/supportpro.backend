import { param } from "express-validator";
import { paginationRules } from "./shared.js";

export const conversationIdParamValidator = [
  param("id").notEmpty().withMessage("Conversation ID is required"),
];

export const conversationMessagesValidator = [
  param("id").notEmpty().withMessage("Conversation ID is required"),
  ...paginationRules,
];
