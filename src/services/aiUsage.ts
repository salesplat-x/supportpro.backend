import axios from "axios";
import env from "../config/env.js";
import { AppDataSource } from "../database/dataSource.js";
import { resultRows } from "../utils/durableJobs.js";
import { getAiProvider, isProviderConfigured } from "../utils/integrations/ai/catalog.js";
import logger from "../utils/logger.js";

// ---- Balances: only DeepSeek and ElevenLabs offer an API for what is left ----

interface Balance {
  amount: number;
  unit: string;
  /** The provider says nothing can be spent until the account is topped up. */
  empty: boolean;
}

const BALANCE_TIMEOUT_MS = 10_000;

const deepSeekBalance = async (): Promise<Balance | null> => {
  const provider = getAiProvider("deepseek");
  if (!provider || !isProviderConfigured(provider)) return null;
  const { data } = await axios.get<{
    is_available?: boolean;
    balance_infos?: Array<{ currency?: string; total_balance?: string }>;
  }>(`${provider.baseUrl.replace(/\/$/, "")}/user/balance`, {
    headers: { Authorization: `Bearer ${process.env[provider.envKey]!.trim()}` },
    timeout: BALANCE_TIMEOUT_MS,
  });
  const infos = data.balance_infos ?? [];
  const info = infos.find((entry) => entry.currency === "USD") ?? infos[0];
  if (!info) return null;
  return {
    amount: Number(info.total_balance ?? 0),
    unit: info.currency ?? "USD",
    empty: data.is_available === false,
  };
};

const elevenLabsBalance = async (): Promise<Balance | null> => {
  if (!env.elevenlabsApiKey) return null;
  const { data } = await axios.get<{ character_count?: number; character_limit?: number }>(
    "https://api.elevenlabs.io/v1/user/subscription",
    { headers: { "xi-api-key": env.elevenlabsApiKey }, timeout: BALANCE_TIMEOUT_MS }
  );
  if (typeof data.character_limit !== "number") return null;
  const left = Math.max(0, data.character_limit - (data.character_count ?? 0));
  return { amount: left, unit: "characters", empty: left === 0 };
};

const BALANCE_SOURCES: Record<string, () => Promise<Balance | null>> = {
  deepseek: deepSeekBalance,
  elevenlabs: elevenLabsBalance,
};

const BALANCE_EVERY = "1 hour";
const BALANCE_SWEEP_EVERY_MS = 5 * 60_000;
let lastBalanceSweepAt = 0;

/**
 * Fetches each balance at most hourly across every instance: the conditional update on
 * balance_checked_at is the claim. A failed fetch leaves no balance rather than a stale one.
 * An empty account counts as out of credit, and money on it ends that.
 */
export const checkProviderBalances = async (
  options: { force?: boolean } = {}
): Promise<{ checked: string[] }> => {
  if (!options.force && Date.now() - lastBalanceSweepAt < BALANCE_SWEEP_EVERY_MS) {
    return { checked: [] };
  }
  lastBalanceSweepAt = Date.now();

  const checked: string[] = [];
  for (const [provider, fetchBalance] of Object.entries(BALANCE_SOURCES)) {
    await AppDataSource.query(
      `INSERT INTO "ai_provider_status" ("provider") VALUES ($1) ON CONFLICT DO NOTHING`,
      [provider]
    );
    const claimed = resultRows(
      await AppDataSource.query(
        `UPDATE "ai_provider_status" SET "balance_checked_at" = NOW()
         WHERE "provider" = $1
           AND ("balance_checked_at" IS NULL OR "balance_checked_at" < NOW() - INTERVAL '${BALANCE_EVERY}')
         RETURNING "provider"`,
        [provider]
      )
    );
    if (claimed.length === 0) continue;

    let balance: Balance | null = null;
    try {
      balance = await fetchBalance();
    } catch (err) {
      logger.warn(
        `${provider} balance check failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    await AppDataSource.query(
      `UPDATE "ai_provider_status"
       SET "balance" = $2, "balance_unit" = $3, "updated_at" = NOW(),
           "out_of_credit_since" = CASE
             WHEN $4::boolean IS NULL THEN "out_of_credit_since"
             WHEN $4 THEN COALESCE("out_of_credit_since", NOW())
             ELSE NULL END,
           "credit_error" = CASE
             WHEN $4::boolean IS NULL THEN "credit_error"
             WHEN $4 THEN COALESCE("credit_error", 'balance empty')
             ELSE NULL END
       WHERE "provider" = $1`,
      [provider, balance?.amount ?? null, balance?.unit ?? null, balance ? balance.empty : null]
    );
    checked.push(provider);
  }
  return { checked };
};
