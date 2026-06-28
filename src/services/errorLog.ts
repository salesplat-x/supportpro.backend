import { Request, Response } from "express";
import { AppDataSource } from "../database/dataSource.js";
import { ErrorLog } from "../entities/ErrorLog.js";
import { ErrorLogLevel } from "../types/enums.js";
import logger from "../utils/logger.js";
import env from "../config/env.js";
import { v4 as uuidv4 } from "uuid";

function errorLogRepo() {
  return AppDataSource.getRepository(ErrorLog);
}

export interface ErrorLogData {
  message: string;
  stack?: string;
  errorType: string;
  level?: ErrorLogLevel;
  userId?: string;
  requestId?: string;
  endpoint?: string;
  method?: string;
  userAgent?: string;
  ip?: string;
  requestBody?: Record<string, unknown>;
  requestQuery?: Record<string, unknown>;
  requestParams?: Record<string, unknown>;
  responseStatus?: number;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

class ErrorLoggerService {
  private generateRequestId(): string {
    return uuidv4();
  }

  private sanitizeData(
    data: Record<string, unknown> | undefined
  ): Record<string, unknown> | undefined {
    if (!data) return data;

    const sensitiveFields = ["password", "token", "secret", "key", "authorization"];
    const sanitized = { ...data };

    sensitiveFields.forEach((field) => {
      if (sanitized[field]) {
        sanitized[field] = "[REDACTED]";
      }
    });

    return sanitized;
  }

  private extractRequestInfo(req: Request): Partial<ErrorLogData> {
    return {
      endpoint: req.originalUrl,
      method: req.method,
      userAgent: req.get("User-Agent"),
      ip: req.ip ?? req.socket?.remoteAddress,
      requestBody: this.sanitizeData(req.body as Record<string, unknown>),
      requestQuery: this.sanitizeData(req.query as Record<string, unknown>),
      requestParams: this.sanitizeData(req.params as Record<string, unknown>),
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

    const errorLogData: Partial<ErrorLog> = {
      timestamp: new Date(),
      level: additionalData?.level ?? ErrorLogLevel.Error,
      message: errorMessage,
      stack: errorStack ?? null,
      errorType,
      requestId,
      environment: env.app_env,
      version: process.env.npm_package_version ?? "1.0.0",
      metadata: additionalData?.metadata ?? null,
      tags: additionalData?.tags ?? null,
      resolved: false,
      ...additionalData,
    };

    if (req) {
      const reqInfo = this.extractRequestInfo(req);
      Object.assign(errorLogData, reqInfo);
    }

    if (res) {
      errorLogData.responseStatus = res.statusCode;
    }

    try {
      const errorLog = errorLogRepo().create(errorLogData);
      await errorLogRepo().save(errorLog);

      logger.error(`${errorMessage} [RequestId: ${requestId}]`);

      return requestId;
    } catch (dbError) {
      console.error("Failed to save error log to database:", dbError);
      logger.error(errorMessage);
      return requestId;
    }
  }

  async getErrorLogs(
    filters: {
      level?: ErrorLogLevel;
      environment?: string;
      resolved?: boolean;
      errorType?: string;
      startDate?: Date;
      endDate?: Date;
      limit?: number;
      skip?: number;
    } = {}
  ): Promise<{ logs: ErrorLog[]; total: number }> {
    const qb = errorLogRepo().createQueryBuilder("log");

    if (filters.level) qb.andWhere("log.level = :level", { level: filters.level });
    if (filters.environment) qb.andWhere("log.environment = :env", { env: filters.environment });
    if (filters.resolved !== undefined)
      qb.andWhere("log.resolved = :resolved", { resolved: filters.resolved });
    if (filters.errorType)
      qb.andWhere("log.errorType = :errorType", { errorType: filters.errorType });
    if (filters.startDate)
      qb.andWhere("log.timestamp >= :startDate", { startDate: filters.startDate });
    if (filters.endDate) qb.andWhere("log.timestamp <= :endDate", { endDate: filters.endDate });

    const total = await qb.getCount();
    const logs = await qb
      .orderBy("log.timestamp", "DESC")
      .skip(filters.skip ?? 0)
      .take(filters.limit ?? 50)
      .getMany();

    return { logs, total };
  }

  async markErrorAsResolved(
    requestId: string,
    resolvedBy: string,
    notes?: string
  ): Promise<boolean> {
    try {
      const result = await errorLogRepo()
        .createQueryBuilder()
        .update(ErrorLog)
        .set({
          resolved: true,
          resolvedAt: new Date(),
          resolvedBy,
          ...(notes ? { metadata: { resolutionNotes: notes } } : {}),
        })
        .where("requestId = :requestId", { requestId })
        .execute();

      return (result.affected ?? 0) > 0;
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
          errorLogRepo().count(),
          errorLogRepo().count({ where: { resolved: true } }),
          errorLogRepo().count({ where: { resolved: false } }),
          errorLogRepo()
            .createQueryBuilder("log")
            .select("log.errorType", "errorType")
            .addSelect("COUNT(*)", "count")
            .groupBy("log.errorType")
            .orderBy("count", "DESC")
            .getRawMany<{ errorType: string; count: string }>(),
          errorLogRepo()
            .createQueryBuilder("log")
            .select("log.level", "level")
            .addSelect("COUNT(*)", "count")
            .groupBy("log.level")
            .orderBy("count", "DESC")
            .getRawMany<{ level: string; count: string }>(),
        ]);

      return {
        totalErrors,
        resolvedErrors,
        unresolvedErrors,
        errorsByType: errorsByType.reduce(
          (acc, item) => {
            acc[item.errorType] = Number(item.count);
            return acc;
          },
          {} as Record<string, number>
        ),
        errorsByLevel: errorsByLevel.reduce(
          (acc, item) => {
            acc[item.level] = Number(item.count);
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

  async cleanupOldLogs(daysToKeep = 30): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      const result = await errorLogRepo()
        .createQueryBuilder()
        .delete()
        .from(ErrorLog)
        .where("timestamp < :cutoffDate", { cutoffDate })
        .andWhere("resolved = true")
        .execute();

      return result.affected ?? 0;
    } catch (error) {
      console.error("Failed to cleanup old logs:", error);
      return 0;
    }
  }
}

export const errorLogger = new ErrorLoggerService();
export default errorLogger;
