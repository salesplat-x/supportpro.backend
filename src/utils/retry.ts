import logger from "./logger.js";

interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label?: string;
}

const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNABORTED",
  "EAI_AGAIN",
]);

const getStatus = (err: unknown): number | undefined => {
  const e = err as Record<string, unknown> | undefined;
  if (!e) return undefined;
  const response = e.response as Record<string, unknown> | undefined;
  const candidates = [e.status, e.statusCode, e.http_code, response?.status];
  return candidates.find((c): c is number => typeof c === "number");
};

const isRetryableError = (err: unknown): boolean => {
  const status = getStatus(err);
  if (status !== undefined) {
    return status === 429 || status >= 500;
  }
  const code = (err as { code?: string } | undefined)?.code;
  return code !== undefined && RETRYABLE_CODES.has(code);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries transient failures (429 rate limits, 5xx, connection resets/timeouts) with
 * exponential backoff + jitter. Non-retryable errors (4xx, validation, parse errors) fail immediately.
 */
export const withRetry = async <T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> => {
  const { retries = 3, baseDelayMs = 500, maxDelayMs = 8000, label = "operation" } = options;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries || !isRetryableError(err)) {
        throw err;
      }
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delay = backoff + Math.random() * backoff * 0.3;
      logger.warn(
        `${label} failed (attempt ${attempt}/${retries}), retrying in ${Math.round(delay)}ms: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      await sleep(delay);
    }
  }
  // Unreachable — loop always returns or throws — but keeps TS happy.
  throw new Error(`${label} failed after ${retries} attempts`);
};
