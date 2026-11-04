import crypto from "crypto";
import type OpenAI from "openai";
import { AppDataSource } from "../database/dataSource.js";
import { resultRows } from "../utils/durableJobs.js";
import { AppError, ConflictError } from "../utils/errors";
import logger from "../utils/logger.js";
import { withTimeout } from "./staffInvite.js";

/** Below Cloudflare's 100 seconds, so a slow call is reported instead of cut off by the proxy. */
export const AI_TOTAL_LIMIT_MS = 80_000;
const AI_UNAVAILABLE = "The AI could not answer just now. Please try again.";

const CLAIM_SQL = `
  INSERT INTO people_ai_claims ("key", "token", "claimed_at")
  VALUES ($1, $2, NOW())
  ON CONFLICT ("key") DO UPDATE
    SET "token" = EXCLUDED."token", "claimed_at" = NOW()
    WHERE people_ai_claims."claimed_at" < NOW() - INTERVAL '3 minutes'
  RETURNING "key"`;

export const claimAiWork = async (key: string, token: string): Promise<boolean> =>
  resultRows(await AppDataSource.query(CLAIM_SQL, [key, token])).length > 0;

export const releaseAiWork = async (key: string, token: string): Promise<void> => {
  await AppDataSource.query(`DELETE FROM people_ai_claims WHERE "key" = $1 AND "token" = $2`, [
    key,
    token,
  ]);
};

export const clearOldAiClaims = async (): Promise<void> => {
  await AppDataSource.query(
    `DELETE FROM people_ai_claims WHERE "claimed_at" < NOW() - INTERVAL '1 day'`
  );
};

/** Runs `work` only if no other call holds this key. Never holds a database connection meanwhile. */
export const withAiClaim = async <T>(key: string, work: () => Promise<T>): Promise<T> => {
  const token = crypto.randomUUID();
  if (!(await claimAiWork(key, token))) {
    throw new ConflictError("This is already running. Give it a moment and refresh.");
  }
  try {
    return await work();
  } finally {
    await releaseAiWork(key, token).catch((err: Error) =>
      logger.error(`Could not release AI claim ${key}: ${err.message}`)
    );
  }
};

/** Bad or missing AI output saves nothing and can be retried. */
export const aiFailure = (): AppError => new AppError(502, "AI_UNAVAILABLE", AI_UNAVAILABLE);

export const askAi = async (
  call: () => Promise<OpenAI.Chat.Completions.ChatCompletion.Choice | undefined>
): Promise<Record<string, unknown>> => {
  let content: string | null | undefined;
  try {
    const reply = await withTimeout(call(), AI_TOTAL_LIMIT_MS, "The AI did not respond");
    content = reply?.message.content;
  } catch (err) {
    logger.error(`People AI call failed: ${(err as Error).message}`);
    throw aiFailure();
  }
  try {
    return JSON.parse(content ?? "") as Record<string, unknown>;
  } catch {
    throw aiFailure();
  }
};

/** Postgres refuses NUL bytes, and nothing has checked AI output yet. */
export const cleanAiText = (value: unknown, maxLength: number): string =>
  typeof value === "string" ? value.replace(/\0/g, "").trim().slice(0, maxLength) : "";
