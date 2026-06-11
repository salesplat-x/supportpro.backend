import { Request, Response } from "express";
import { asyncHandler } from "../../middlewares/v1/handler";
import errorLogger from "../../services/errorLogger";
import { sendSuccessResponse } from "../../helpers/response";

export const getErrorLogs = asyncHandler(async (req: Request, res: Response) => {
  const {
    level,
    environment,
    resolved,
    errorType,
    startDate,
    endDate,
    limit = 50,
    skip = 0,
  } = req.query;

  const filters = {
    level: level as string,
    environment: environment as string,
    resolved: resolved === "true" ? true : resolved === "false" ? false : undefined,
    errorType: errorType as string,
    startDate: startDate ? new Date(startDate as string) : undefined,
    endDate: endDate ? new Date(endDate as string) : undefined,
    limit: Number(limit),
    skip: Number(skip),
  };

  const result = await errorLogger.getErrorLogs(filters);

  return sendSuccessResponse(res, "Error logs retrieved successfully", result, 200);
});

export const getErrorStats = asyncHandler(async (req: Request, res: Response) => {
  const stats = await errorLogger.getErrorStats();

  return sendSuccessResponse(res, "Error statistics retrieved successfully", stats, 200);
});

export const markErrorAsResolved = asyncHandler(async (req: Request, res: Response) => {
  const { requestId } = req.params;
  const { resolvedBy, notes } = req.body;

  if (!requestId) {
    return res.status(400).json({
      status: false,
      message: "requestId is required",
    });
  }

  if (!resolvedBy) {
    return res.status(400).json({
      status: false,
      message: "resolvedBy is required",
    });
  }

  const success = await errorLogger.markErrorAsResolved(requestId, resolvedBy, notes);

  if (!success) {
    return res.status(404).json({
      status: false,
      message: "Error log not found",
    });
  }

  return sendSuccessResponse(res, "Error marked as resolved successfully", { requestId }, 200);
});

export const cleanupOldLogs = asyncHandler(async (req: Request, res: Response) => {
  const { daysToKeep = 30 } = req.body;

  const deletedCount = await errorLogger.cleanupOldLogs(Number(daysToKeep));

  return sendSuccessResponse(
    res,
    "Old logs cleaned up successfully",
    { deletedCount, daysToKeep },
    200
  );
});
