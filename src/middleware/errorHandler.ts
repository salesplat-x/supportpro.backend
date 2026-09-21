import { Request, Response, NextFunction } from "express";
import { QueryFailedError } from "typeorm";
import { MulterError } from "multer";
import { AppError } from "../utils/errors/AppError.js";
import { ValidationError } from "../utils/errors/ValidationError.js";
import { PlanLimitError } from "../utils/errors/PlanLimitError.js";
import logger from "../utils/logger.js";
import env from "../config/env.js";

const isProd = env.app_env === "production";

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
      error: { code: err.code, message: err.message },
    });
    return;
  }

  if (err instanceof QueryFailedError) {
    logger.error("Database query failed", { message: err.message, stack: err.stack });
    const message = isProd ? "A database error occurred" : err.message;
    res.status(500).json({
      success: false,
      error: { code: "DATABASE_ERROR", message },
    });
    return;
  }

  const message = err instanceof Error ? err.message : "An unexpected error occurred";
  logger.error("Unhandled error", {
    message,
    stack: err instanceof Error ? err.stack : undefined,
  });

  res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message: isProd ? "An unexpected error occurred" : message,
    },
  });
}
