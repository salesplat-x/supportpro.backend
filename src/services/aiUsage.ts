import axios from "axios";
import env from "../config/env.js";
import { AppDataSource } from "../database/dataSource.js";
import { resultRows } from "../utils/durableJobs.js";
import {
  type AiCatalog,
  findModel,
  getAiProvider,
  isProviderConfigured,
  loadAiCatalog,
  priceOn,
} from "../utils/integrations/ai/catalog.js";
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

// ---- The admin's AI usage page ----

export const USAGE_RANGES = [1, 7, 30] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export interface AiUsageTotals {
  calls: number;
  failedCalls: number;
  creditFailures: number;
  inputTokens: number;
  outputTokens: number;
  characters: number;
  audioSeconds: number;
  /** Estimated at catalogue prices. Calls with no USD price add nothing; see unpricedCalls. */
  costUsd: number;
  unpricedCalls: number;
}

export interface AiUsageRow extends AiUsageTotals {
  key: string;
  label: string;
  provider: string | null;
}

export interface AiProviderCard {
  key: string;
  name: string;
  configured: boolean;
  outOfCreditSince: Date | null;
  creditError: string | null;
  balance: number | null;
  balanceUnit: string | null;
  balanceCheckedAt: Date | null;
}

export interface AiUsageOverview {
  days: UsageRange;
  from: string;
  pricesVerifiedOn: string | null;
  providers: AiProviderCard[];
  totals: AiUsageTotals;
  byProvider: AiUsageRow[];
  byModel: AiUsageRow[];
  byFeature: AiUsageRow[];
}

const ELEVENLABS = { key: "elevenlabs", name: "ElevenLabs" };

// AI work outside the catalogue's jobs: the voice assistant, interview audio and model tests.
const EXTRA_FEATURE_NAMES: Record<string, string> = {
  voice_transcription: "Voice assistant: speech to text",
  voice_reply: "Voice assistant: replies",
  voice_speech: "Voice assistant: reading replies aloud",
  interview_question_audio: "AI interview: reading questions aloud",
  manual_test: "Model tests by admins",
};

interface UsageDayRow {
  day: string;
  provider: string;
  model: string;
  feature: string;
  calls: number;
  failed_calls: number;
  credit_failures: number;
  input_tokens: string;
  output_tokens: string;
  characters: string;
  audio_seconds: string;
}

const emptyTotals = (): AiUsageTotals => ({
  calls: 0,
  failedCalls: 0,
  creditFailures: 0,
  inputTokens: 0,
  outputTokens: 0,
  characters: 0,
  audioSeconds: 0,
  costUsd: 0,
  unpricedCalls: 0,
});

/** USD for one day's row, or null when the work has no USD price (ElevenLabs, unpriced models). */
const costOf = (catalog: AiCatalog, row: UsageDayRow): number | null => {
  const audio = catalog.audioPricing?.find(
    (price) => price.provider === row.provider && price.model === row.model
  );
  if (audio) return (Number(row.audio_seconds) / 60) * audio.perMinute;
  const model = findModel(catalog, { provider: row.provider, model: row.model });
  const price = model ? priceOn(model, row.day) : null;
  if (!price) return null;
  return (
    (Number(row.input_tokens) * price.inputPerMillion +
      Number(row.output_tokens) * (price.outputPerMillion ?? 0)) /
    1_000_000
  );
};

const addInto = (totals: AiUsageTotals, row: UsageDayRow, cost: number | null): void => {
  totals.calls += row.calls;
  totals.failedCalls += row.failed_calls;
  totals.creditFailures += row.credit_failures;
  totals.inputTokens += Number(row.input_tokens);
  totals.outputTokens += Number(row.output_tokens);
  totals.characters += Number(row.characters);
  totals.audioSeconds += Number(row.audio_seconds);
  if (cost === null) totals.unpricedCalls += row.calls;
  else totals.costUsd += cost;
};

const rounded = (totals: AiUsageTotals): AiUsageTotals => ({
  ...totals,
  costUsd: Math.round(totals.costUsd * 10_000) / 10_000,
  audioSeconds: Math.round(totals.audioSeconds * 100) / 100,
});

const byCalls = (a: AiUsageRow, b: AiUsageRow) =>
  b.calls - a.calls || a.label.localeCompare(b.label);

export const getAiUsageOverview = async (days: UsageRange): Promise<AiUsageOverview> => {
  const catalog = loadAiCatalog();
  const [rows, statuses, [range]] = await Promise.all([
    AppDataSource.query(
      `SELECT "day"::text AS "day", "provider", "model", "feature", "calls", "failed_calls",
              "credit_failures", "input_tokens", "output_tokens", "characters", "audio_seconds"
       FROM "ai_usage_daily"
       WHERE "day" > (NOW() AT TIME ZONE 'UTC')::date - $1::int`,
      [days]
    ) as Promise<UsageDayRow[]>,
    AppDataSource.query(`SELECT * FROM "ai_provider_status"`) as Promise<
      Array<{
        provider: string;
        out_of_credit_since: Date | null;
        credit_error: string | null;
        balance: string | null;
        balance_unit: string | null;
        balance_checked_at: Date | null;
      }>
    >,
    AppDataSource.query(
      `SELECT ((NOW() AT TIME ZONE 'UTC')::date - ($1::int - 1))::text AS "from"`,
      [days]
    ) as Promise<Array<{ from: string }>>,
  ]);

  const providerName = (key: string) =>
    key === ELEVENLABS.key
      ? ELEVENLABS.name
      : (catalog.providers.find((provider) => provider.key === key)?.name ?? key);
  const modelLabel = (provider: string, model: string) =>
    findModel(catalog, { provider, model })?.label ?? model;
  const featureName = (key: string) =>
    catalog.features.find((feature) => feature.key === key)?.name ??
    EXTRA_FEATURE_NAMES[key] ??
    key;

  const totals = emptyTotals();
  const groups = {
    byProvider: new Map<string, AiUsageRow>(),
    byModel: new Map<string, AiUsageRow>(),
    byFeature: new Map<string, AiUsageRow>(),
  };
  const groupRow = (
    map: Map<string, AiUsageRow>,
    key: string,
    label: string,
    provider: string | null
  ) => {
    let row = map.get(key);
    if (!row) {
      row = { key, label, provider, ...emptyTotals() };
      map.set(key, row);
    }
    return row;
  };

  for (const row of rows) {
    const cost = costOf(catalog, row);
    addInto(totals, row, cost);
    addInto(groupRow(groups.byProvider, row.provider, providerName(row.provider), null), row, cost);
    addInto(
      groupRow(
        groups.byModel,
        `${row.provider}:${row.model}`,
        modelLabel(row.provider, row.model),
        row.provider
      ),
      row,
      cost
    );
    addInto(groupRow(groups.byFeature, row.feature, featureName(row.feature), null), row, cost);
  }

  const statusOf = new Map(statuses.map((status) => [status.provider, status]));
  const card = (key: string, name: string, configured: boolean): AiProviderCard => {
    const status = statusOf.get(key);
    return {
      key,
      name,
      configured,
      outOfCreditSince: status?.out_of_credit_since ?? null,
      creditError: status?.credit_error ?? null,
      balance: status?.balance != null ? Number(status.balance) : null,
      balanceUnit: status?.balance_unit ?? null,
      balanceCheckedAt: status?.balance_checked_at ?? null,
    };
  };

  const list = (map: Map<string, AiUsageRow>) =>
    [...map.values()].map((row) => ({ ...row, ...rounded(row) })).sort(byCalls);

  return {
    days,
    from: range!.from,
    pricesVerifiedOn: catalog.pricesVerifiedOn ?? null,
    providers: [
      ...catalog.providers.map((provider) =>
        card(provider.key, provider.name, isProviderConfigured(provider))
      ),
      card(ELEVENLABS.key, ELEVENLABS.name, !!env.elevenlabsApiKey),
    ],
    totals: rounded(totals),
    byProvider: list(groups.byProvider),
    byModel: list(groups.byModel),
    byFeature: list(groups.byFeature),
  };
};

/** When each provider last started refusing calls for billing; absent means it is fine. */
export const outOfCreditSinceByProvider = async (): Promise<Map<string, Date>> => {
  const rows: Array<{ provider: string; out_of_credit_since: Date }> = await AppDataSource.query(
    `SELECT "provider", "out_of_credit_since" FROM "ai_provider_status"
     WHERE "out_of_credit_since" IS NOT NULL`
  );
  return new Map(rows.map((row) => [row.provider, row.out_of_credit_since]));
};
