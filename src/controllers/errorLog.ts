import { Request, Response } from "express";
import { errorLogger } from "../services/errorLog.js";
import { sendSuccessResponse } from "../utils/response.js";

export const getErrorLogs = async (req: Request, res: Response) => {
  const result = await errorLogger.getErrorLogs(req.query as Record<string, string>);
  sendSuccessResponse(res, "Error logs fetched", result);
};

export const getErrorStats = async (_req: Request, res: Response) => {
  const result = await errorLogger.getErrorStats();
  sendSuccessResponse(res, "Error stats fetched", result);
};

export const markErrorAsResolved = async (req: Request, res: Response) => {
  const result = await errorLogger.markErrorAsResolved(
    req.params["requestId"]!,
    req.body.resolvedBy,
    req.body.notes
  );
  sendSuccessResponse(res, "Error marked as resolved", { log: result });
};

export const cleanupOldLogs = async (req: Request, res: Response) => {
  const deleted = await errorLogger.cleanupOldLogs(req.body.daysToKeep);
  sendSuccessResponse(res, "Old logs cleaned up", { deleted });
};
