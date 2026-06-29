import { param, query, body } from "express-validator";
import { ErrorLogLevel } from "../types/enums.js";

export const getErrorLogsQueryValidator = [
  query("level").optional().isIn(Object.values(ErrorLogLevel)).withMessage("Invalid log level"),
  query("environment").optional().isString(),
  query("resolved").optional().isBoolean().toBoolean(),
  query("errorType").optional().isString(),
  query("startDate").optional().isISO8601().toDate(),
  query("endDate").optional().isISO8601().toDate(),
  query("limit").optional().isInt({ min: 1 }).toInt(),
  query("skip").optional().isInt({ min: 0 }).toInt(),
];

export const resolveErrorLogValidator = [
  param("requestId").notEmpty().withMessage("Request ID is required"),
  body("resolvedBy").notEmpty().withMessage("resolvedBy is required"),
  body("notes").optional().isString(),
];

export const cleanupLogsValidator = [body("daysToKeep").optional().isInt({ min: 1 }).toInt()];
