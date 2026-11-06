import { body, param, query } from "express-validator";
import { FEEDBACK_TEXT_MAX_LENGTH, FEEDBACK_TOPICS } from "../entities/Feedback.js";
import { SUPPORT_STATUSES } from "../services/supportStatus.js";

const requiredText = (field: string, emptyMessage: string) =>
  body(field)
    .isString()
    .withMessage(emptyMessage)
    .bail()
    .trim()
    .notEmpty()
    .withMessage(emptyMessage)
    .bail()
    .isLength({ max: FEEDBACK_TEXT_MAX_LENGTH })
    .withMessage(`Keep it under ${FEEDBACK_TEXT_MAX_LENGTH.toLocaleString("en")} characters`);

export const submitFeedbackValidator = [
  requiredText("message", "Write your message"),
  body("topic")
    .optional({ values: "null" })
    .isIn(FEEDBACK_TOPICS)
    .withMessage("Choose a topic from the list"),
  body("clientRequestId").optional({ values: "null" }).isUUID().withMessage("Invalid request id"),
];

export const listFeedbackQueryValidator = [
  query("status").optional().isIn(SUPPORT_STATUSES).withMessage("Unknown status"),
  query("topic").optional().isIn(FEEDBACK_TOPICS).withMessage("Unknown topic"),
  query("search")
    .optional()
    .isString()
    .trim()
    .isLength({ max: 100 })
    .withMessage("Search is too long"),
  query("sortBy").optional().isIn(["status", "createdAt"]).withMessage("Unknown sort"),
  query("sort").optional().isIn(["asc", "desc"]).withMessage("Sort must be asc or desc"),
  query("limit").optional().isInt({ min: 1 }).toInt(),
  query("offset").optional().isInt({ min: 0 }).toInt(),
];

export const feedbackIdParamValidator = [param("id").isUUID().withMessage("Invalid request id")];

export const saveDraftValidator = [
  ...feedbackIdParamValidator,
  body("draft")
    .isString()
    .withMessage("The draft must be text")
    .bail()
    .isLength({ max: FEEDBACK_TEXT_MAX_LENGTH })
    .withMessage(`Keep it under ${FEEDBACK_TEXT_MAX_LENGTH.toLocaleString("en")} characters`),
];

export const replyValidator = [...feedbackIdParamValidator, requiredText("reply", "Write a reply")];
