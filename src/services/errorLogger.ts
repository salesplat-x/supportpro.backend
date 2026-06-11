import { Request, Response } from "express";
import ErrorLog, { IErrorLog } from "../models/v1/errorLog";
import logger from "../config/logger";
import env from "../config/env";
import { v4 as uuidv4 } from "uuid";

export interface ErrorLogData {
  message: string;
  stack?: string;
  errorType: string;
  level?: "error" | "warn" | "info" | "debug";
  userId?: string;
  requestId?: string;
  endpoint?: string;
  method?: string;
  userAgent?: string;
  ip?: string;
  requestBody?: any;
  requestQuery?: any;
  requestParams?: any;
  responseStatus?: number;
  metadata?: Record<string, any>;
  tags?: string[];
}

class ErrorLoggerService {
  private generateRequestId(): string {
    return uuidv4();
  }

  private sanitizeData(data: any): any {
    if (!data) return data;

    // Remove sensitive fields
    const sensitiveFields = ["password", "token", "secret", "key", "authorization"];
    const sanitized = { ...data };

    sensitiveFields.forEach((field) => {
      if (sanitized[field]) {
        sanitized[field] = "[REDACTED]";
      }
    });

    return sanitized;
  }

  private extractRequestInfo(req: Request): Partial<IErrorLog> {
    return {
      endpoint: req.originalUrl,
      method: req.method,
      userAgent: req.get("User-Agent"),
      ip: req.ip || req.connection.remoteAddress,
      requestBody: this.sanitizeData(req.body),
      requestQuery: this.sanitizeData(req.query),
      requestParams: this.sanitizeData(req.params),
    };
  }

  async logError(
    error: Error | string,
    req?: Request,
    res?: Response,
    additionalData?: Partial<ErrorLogData>
  ): Promise<string> {
    const requestId = this.generateRequestId();
    const errorMessage = typeof error === "string" ? error : error.message;
    const errorStack = error instanceof Error ? error.stack : undefined;
    const errorType = error instanceof Error ? error.constructor.name : "UnknownError";

    const errorLogData: Partial<IErrorLog> = {
      timestamp: new Date(),
      level: additionalData?.level || "error",
      message: errorMessage,
      stack: errorStack,
      errorType,
      requestId,
      environment: env.app_env,
      version: process.env.npm_package_version || "1.0.0",
      metadata: additionalData?.metadata || {},
      tags: additionalData?.tags || [],
      resolved: false,
      ...additionalData,
    };

    if (req) {
      Object.assign(errorLogData, this.extractRequestInfo(req));
    }

    if (res) {
      errorLogData.responseStatus = res.statusCode;
    }

    try {
      const errorLog = new ErrorLog(errorLogData);
      await errorLog.save();

      logger.logErrorToConsole(new Error(`${errorMessage} [RequestId: ${requestId}]`));

      return requestId;
    } catch (dbError) {
      console.error("Failed to save error log to database:", dbError);
      logger.logErrorToConsole(new Error(errorMessage));
      return requestId;
    }
  }

  async getErrorLogs(
    filters: {
      level?: string;
      environment?: string;
      resolved?: boolean;
      errorType?: string;
      startDate?: Date;
      endDate?: Date;
      limit?: number;
      skip?: number;
    } = {}
  ): Promise<{ logs: IErrorLog[]; total: number }> {
    const query: any = {};

    if (filters.level) query.level = filters.level;
    if (filters.environment) query.environment = filters.environment;
    if (filters.resolved !== undefined) query.resolved = filters.resolved;
    if (filters.errorType) query.errorType = filters.errorType;

    if (filters.startDate || filters.endDate) {
      query.timestamp = {};
      if (filters.startDate) query.timestamp.$gte = filters.startDate;
      if (filters.endDate) query.timestamp.$lte = filters.endDate;
    }

    const total = await ErrorLog.countDocuments(query);
    const logs = await ErrorLog.find(query)
      .sort({ timestamp: -1 })
      .limit(filters.limit || 50)
      .skip(filters.skip || 0);

    return { logs, total };
  }

  async markErrorAsResolved(
    requestId: string,
    resolvedBy: string,
    notes?: string
  ): Promise<boolean> {
    try {
      const result = await ErrorLog.updateOne(
        { requestId },
        {
          resolved: true,
          resolvedAt: new Date(),
          resolvedBy,
          ...(notes && { metadata: { resolutionNotes: notes } }),
        }
      );
      return result.modifiedCount > 0;
    } catch (error) {
      console.error("Failed to mark error as resolved:", error);
      return false;
    }
  }

  async getErrorStats(): Promise<{
    totalErrors: number;
    resolvedErrors: number;
    unresolvedErrors: number;
    errorsByType: Record<string, number>;
    errorsByLevel: Record<string, number>;
  }> {
    try {
      const [totalErrors, resolvedErrors, unresolvedErrors, errorsByType, errorsByLevel] =
        await Promise.all([
          ErrorLog.countDocuments(),
          ErrorLog.countDocuments({ resolved: true }),
          ErrorLog.countDocuments({ resolved: false }),
          ErrorLog.aggregate([
            { $group: { _id: "$errorType", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
          ]),
          ErrorLog.aggregate([
            { $group: { _id: "$level", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
          ]),
        ]);

      return {
        totalErrors,
        resolvedErrors,
        unresolvedErrors,
        errorsByType: errorsByType.reduce(
          (acc, item) => {
            acc[item._id] = item.count;
            return acc;
          },
          {} as Record<string, number>
        ),
        errorsByLevel: errorsByLevel.reduce(
          (acc, item) => {
            acc[item._id] = item.count;
            return acc;
          },
          {} as Record<string, number>
        ),
      };
    } catch (error) {
      console.error("Failed to get error stats:", error);
      return {
        totalErrors: 0,
        resolvedErrors: 0,
        unresolvedErrors: 0,
        errorsByType: {},
        errorsByLevel: {},
      };
    }
  }

  async cleanupOldLogs(daysToKeep: number = 30): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      const result = await ErrorLog.deleteMany({
        timestamp: { $lt: cutoffDate },
        resolved: true, // Only delete resolved errors
      });

      return result.deletedCount || 0;
    } catch (error) {
      console.error("Failed to cleanup old logs:", error);
      return 0;
    }
  }
}

export const errorLogger = new ErrorLoggerService();
export default errorLogger;
