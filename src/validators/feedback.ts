import { body, param, query } from "express-validator";

export const submitFeedbackValidator = [
  body("message").notEmpty().withMessage("Message is required").isString(),
  body("subject").optional().isString(),
];

export const listFeedbackQueryValidator = [
  query("isRead").optional().isBoolean().withMessage("isRead must be a boolean").toBoolean(),
  query("limit").optional().isInt({ min: 1 }).toInt(),
  query("skip").optional().isInt({ min: 0 }).toInt(),
];

export const feedbackIdParamValidator = [param("id").isUUID().withMessage("Invalid feedback id")];
