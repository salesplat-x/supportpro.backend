import { body, param } from "express-validator";

export const createNotificationValidator = [
  body("message").notEmpty().withMessage("Notification message is required"),
  body("userId").optional().isString(),
];

export const notificationIdParamValidator = [
  param("id").notEmpty().withMessage("Notification ID is required"),
];
