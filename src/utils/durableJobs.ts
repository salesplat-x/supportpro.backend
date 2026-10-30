import { AppDataSource } from "../database/dataSource.js";
import { AppError } from "./errors/AppError.js";
import { ValidationError } from "./errors/ValidationError.js";
import { getErrorStatus, isRetryableError } from "./retry.js";

export const MAX_DURABLE_ATTEMPTS = 5;
export const STALE_LOCK_INTERVAL = "5 minutes";
export const STALE_LOCK_MS = 5 * 60 * 1000;
export const SWEEP_BATCH_SIZE = 10;
export const SWEEP_INTERVAL_MS = 30_000;

/** 30s, 1m, 2m, 4m, 8m — `attempt` is 1-based (after the failure just recorded). */
export const backoffMs = (attempt: number): number => {
  const base = 30_000;
  return Math.min(8 * 60 * 1000, base * 2 ** Math.max(0, attempt - 1));
};

/**
 * Durable (sweep) retries are broader than in-process `withRetry`:
 * LLM JSON/schema `ValidationError`s are retried; 401/403/404 AppErrors are not.
 */
export const isDurableRetryable = (err: unknown): boolean => {
  if (err instanceof ValidationError) return true;
  if (err instanceof AppError) return false;
  if (isRetryableError(err)) return true;
  const status = getErrorStatus(err);
  if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
    return false;
  }
  return true;
};

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export interface DurableFailureUpdate {
  attempts: number;
  nextRetryAt: Date | null;
  lockedAt: null;
  lastError: string;
  exhausted: boolean;
}

export const durableFailureUpdate = (
  currentAttempts: number,
  err: unknown,
  maxAttempts = MAX_DURABLE_ATTEMPTS
): DurableFailureUpdate => {
  const attempts = currentAttempts + 1;
  const retryable = isDurableRetryable(err);
  const exhausted = !retryable || attempts >= maxAttempts;
  return {
    attempts,
    nextRetryAt: exhausted ? null : new Date(Date.now() + backoffMs(attempts)),
    lockedAt: null,
    lastError: errorMessage(err),
    exhausted,
  };
};

/**
 * TypeORM's `query()` returns plain rows for a SELECT but a `[rows, affectedCount]`
 * tuple for `UPDATE … RETURNING`. Claim SQL is always the latter, and reading
 * `.length` off the tuple yields 2 whatever happened — so an unwrapped check reports
 * a successful claim even when the conditional UPDATE matched nothing, defeating the
 * lock entirely. Normalise before counting.
 */
const resultRows = (result: unknown): unknown[] => {
  if (!Array.isArray(result)) return [];
  const [first] = result;
  return Array.isArray(first) ? first : result;
};

export const claimRowById = async (sql: string, id: string): Promise<boolean> => {
  const result: unknown = await AppDataSource.query(sql, [id]);
  return resultRows(result).length > 0;
};

export const selectDueIds = async (sql: string, params: unknown[] = []): Promise<string[]> => {
  const result: unknown = await AppDataSource.query(sql, params);
  return resultRows(result).map((row) => (row as { id: string }).id);
};
