import { AppDataSource } from "../../../database/dataSource.js";
import logger from "../../logger.js";
import { creditErrorSummary, isOutOfCreditError } from "./credit.js";

/** Which provider and model did the work, for which AI job. */
export interface AiCallRef {
  provider: string;
  model: string;
  feature: string;
}

export interface AiCallUsage {
  inputTokens?: number;
  outputTokens?: number;
  characters?: number;
  audioSeconds?: number;
}

interface Counts extends AiCallUsage {
  failed?: boolean;
  outOfCredit?: boolean;
}

const pending = new Set<Promise<void>>();

// Recording never slows or fails the AI call it describes.
const inBackground = (work: () => Promise<unknown>): void => {
  const task = work().then(
    () => undefined,
    (err: unknown) => {
      logger.warn(
        `AI usage could not be recorded: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  );
  pending.add(task);
  void task.finally(() => pending.delete(task));
};

export const drainAiUsageWrites = async (): Promise<void> => {
  for (let attempt = 0; attempt < 100 && pending.size > 0; attempt++) {
    await Promise.allSettled([...pending]);
  }
};

const ADD_USAGE_SQL = `
  INSERT INTO "ai_usage_daily" (
    "day", "provider", "model", "feature", "calls", "failed_calls", "credit_failures",
    "input_tokens", "output_tokens", "characters", "audio_seconds"
  )
  VALUES ((NOW() AT TIME ZONE 'UTC')::date, $1, $2, $3, 1, $4, $5, $6, $7, $8, $9)
  ON CONFLICT ("day", "provider", "model", "feature") DO UPDATE SET
    "calls" = "ai_usage_daily"."calls" + 1,
    "failed_calls" = "ai_usage_daily"."failed_calls" + EXCLUDED."failed_calls",
    "credit_failures" = "ai_usage_daily"."credit_failures" + EXCLUDED."credit_failures",
    "input_tokens" = "ai_usage_daily"."input_tokens" + EXCLUDED."input_tokens",
    "output_tokens" = "ai_usage_daily"."output_tokens" + EXCLUDED."output_tokens",
    "characters" = "ai_usage_daily"."characters" + EXCLUDED."characters",
    "audio_seconds" = "ai_usage_daily"."audio_seconds" + EXCLUDED."audio_seconds"
`;

const whole = (value: number | undefined): number =>
  Number.isFinite(value) && value! > 0 ? Math.round(value!) : 0;

const addUsage = (ref: AiCallRef, counts: Counts): void =>
  inBackground(() =>
    AppDataSource.query(ADD_USAGE_SQL, [
      ref.provider.slice(0, 32),
      ref.model.slice(0, 100),
      ref.feature.slice(0, 64),
      counts.failed ? 1 : 0,
      counts.outOfCredit ? 1 : 0,
      whole(counts.inputTokens),
      whole(counts.outputTokens),
      whole(counts.characters),
      Number.isFinite(counts.audioSeconds) ? Math.max(0, counts.audioSeconds!) : 0,
    ])
  );

// Which providers this process last saw out of credit. Refreshed every minute, so a success
// costs a database write only when it ends an outage.
const OUT_OF_CREDIT_CACHE_MS = 60_000;
let knownOutOfCredit = new Set<string>();
let knownAt = 0;

const outOfCreditProviders = async (): Promise<Set<string>> => {
  if (Date.now() - knownAt > OUT_OF_CREDIT_CACHE_MS) {
    const rows: Array<{ provider: string }> = await AppDataSource.query(
      `SELECT "provider" FROM "ai_provider_status" WHERE "out_of_credit_since" IS NOT NULL`
    );
    knownOutOfCredit = new Set(rows.map((row) => row.provider));
    knownAt = Date.now();
  }
  return knownOutOfCredit;
};

export const recordAiCall = (ref: AiCallRef, usage: AiCallUsage = {}): void => {
  addUsage(ref, usage);
  inBackground(async () => {
    const outOfCredit = await outOfCreditProviders();
    if (!outOfCredit.has(ref.provider)) return;
    await AppDataSource.query(
      `UPDATE "ai_provider_status"
       SET "out_of_credit_since" = NULL, "credit_error" = NULL, "updated_at" = NOW()
       WHERE "provider" = $1`,
      [ref.provider]
    );
    outOfCredit.delete(ref.provider);
  });
};

export const recordAiFailure = (ref: AiCallRef, err: unknown): void => {
  const outOfCredit = isOutOfCreditError(err);
  addUsage(ref, { failed: true, outOfCredit });
  if (!outOfCredit) return;
  logger.warn(`${ref.provider} refused ${ref.model} for billing: it is out of credit`);
  inBackground(async () => {
    await AppDataSource.query(
      `INSERT INTO "ai_provider_status" ("provider", "out_of_credit_since", "credit_error", "updated_at")
       VALUES ($1, NOW(), $2, NOW())
       ON CONFLICT ("provider") DO UPDATE SET
         "out_of_credit_since" = COALESCE("ai_provider_status"."out_of_credit_since", NOW()),
         "credit_error" = EXCLUDED."credit_error",
         "updated_at" = NOW()`,
      [ref.provider, creditErrorSummary(err)]
    );
    knownOutOfCredit.add(ref.provider);
  });
};
