import { Request, Response, NextFunction } from "express";
import { QueryFailedError } from "typeorm";
import { MulterError } from "multer";
import { AppError } from "../utils/errors/AppError.js";
import { ValidationError } from "../utils/errors/ValidationError.js";
import { PlanLimitError } from "../utils/errors/PlanLimitError.js";
import logger from "../utils/logger.js";

const INVALID_FORMAT = "Some of the information provided is not in a valid format.";
const CONCURRENT_CHANGE = "Another change was in progress. Please try again.";

// Keyed by Postgres SQLSTATE so a failed query can still say why, without exposing SQL.
const DATABASE_FAILURE_REASONS: Record<string, string> = {
  "23505": "A record with these details already exists.",
  "23502": "Some required information is missing.",
  "22001": "Some of the information provided is too long.",
  "22P02": INVALID_FORMAT,
  "22007": INVALID_FORMAT,
  "22008": INVALID_FORMAT,
  "40001": CONCURRENT_CHANGE,
  "40P01": CONCURRENT_CHANGE,
  "55P03": CONCURRENT_CHANGE,
};

const failureReason = (err: unknown): string => {
  if (err instanceof QueryFailedError) {
    const { code, detail } = err.driverError as { code?: string; detail?: string };
    if (code === "23503") {
      return detail?.includes("is still referenced")
        ? "Other records still depend on it."
        : "Something it refers to no longer exists.";
    }
    if (code && DATABASE_FAILURE_REASONS[code]) {
      return DATABASE_FAILURE_REASONS[code];
    }
  }
  return "Please try again.";
};

const failureMessage = (res: Response, err: unknown): string => {
  const action = res.locals["action"] as string | undefined;
  const reason = failureReason(err);
  return action ? `Could not ${action}. ${reason}` : `Something went wrong. ${reason}`;
};

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE" ? "File is too large" : "Invalid file upload";
    res.status(400).json({
      success: false,
      error: { code: err.code, message },
    });
    return;
  }

  if (err instanceof ValidationError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.fields ? { fields: err.fields } : {}),
      },
    });
    return;
  }

  if (err instanceof PlanLimitError) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        featureKey: err.featureKey,
        planKey: err.planKey,
      },
    });
    return;
  }

  if (err instanceof AppError) {
    if (!err.isOperational) {
      logger.error(err.message, { stack: err.stack });
    }
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.isOperational ? err.message : failureMessage(res, err),
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }

  if (err instanceof QueryFailedError) {
    logger.error("Database query failed", { message: err.message, stack: err.stack });
    res.status(500).json({
      success: false,
      error: { code: "DATABASE_ERROR", message: failureMessage(res, err) },
    });
    return;
  }

  logger.error("Unhandled error", {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });

  res.status(500).json({
    success: false,
    error: { code: "INTERNAL_ERROR", message: failureMessage(res, err) },
  });
}
