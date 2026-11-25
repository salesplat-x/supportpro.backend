const createCompletion = jest.fn();
const createEmbedding = jest.fn();

jest.mock("openai", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: createCompletion } },
    embeddings: { create: createEmbedding },
  })),
}));

jest.mock("axios");
jest.mock("../src/config/env.js", () => {
  const actual = jest.requireActual<{ default: Record<string, unknown> }>("../src/config/env.js");
  return { __esModule: true, default: { ...actual.default, elevenlabsApiKey: "el-test-key" } };
});

import axios from "axios";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { complete, embed } from "../src/utils/integrations/ai/gateway.js";
import {
  drainAiUsageWrites,
  recordAiCall,
  recordAiFailure,
} from "../src/utils/integrations/ai/usage.js";
import { clearAiSettingsCache } from "../src/utils/integrations/ai/settings.js";
import { AiCreditError } from "../src/utils/errors";
import { AiUsageDaily } from "../src/entities/AiUsageDaily.js";
import { AiProviderStatus } from "../src/entities/AiProviderStatus.js";
import { checkProviderBalances } from "../src/services/aiUsage.js";

const axiosGet = axios.get as jest.Mock;

const quotaError = () =>
  Object.assign(new Error("429 You exceeded your current quota"), {
    status: 429,
    code: "insufficient_quota",
    type: "insufficient_quota",
  });

const usageRows = () =>
  testDataSource.getRepository(AiUsageDaily).find({ order: { feature: "ASC" } });
const statusOf = (provider: string) =>
  testDataSource.getRepository(AiProviderStatus).findOneBy({ provider });

beforeAll(async () => {
  await startTestDatabase();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

beforeEach(() => {
  clearAiSettingsCache();
  createCompletion.mockReset();
  createEmbedding.mockReset();
});

afterEach(async () => {
  await drainAiUsageWrites();
  await clearAllTables();
});

const ref = { provider: "openai", model: "gpt-5.6-luna", feature: "job_post_writer" };

describe("recording AI usage", () => {
  it("adds every call for the same day, model and job into one row", async () => {
    recordAiCall(ref, { inputTokens: 100, outputTokens: 20 });
    recordAiCall(ref, { inputTokens: 50, outputTokens: 5 });
    recordAiFailure(ref, new Error("socket hang up"));
    await drainAiUsageWrites();

    const [row] = await usageRows();
    expect(row).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-luna",
      feature: "job_post_writer",
      calls: 3,
      failedCalls: 1,
      creditFailures: 0,
      inputTokens: "150",
      outputTokens: "25",
    });
  });

  it("marks a provider out of credit on a billing refusal and clears it on the next success", async () => {
    recordAiFailure(ref, quotaError());
    await drainAiUsageWrites();

    const out = await statusOf("openai");
    expect(out?.outOfCreditSince).toBeInstanceOf(Date);
    expect(out?.creditError).toBe("429 insufficient_quota");
    expect((await usageRows())[0]).toMatchObject({ failedCalls: 1, creditFailures: 1 });

    recordAiCall(ref, { inputTokens: 1 });
    await drainAiUsageWrites();

    const back = await statusOf("openai");
    expect(back?.outOfCreditSince).toBeNull();
    expect(back?.creditError).toBeNull();
  });

  it("keeps the first time a provider ran out while refusals continue", async () => {
    recordAiFailure(ref, quotaError());
    await drainAiUsageWrites();
    const first = (await statusOf("openai"))!.outOfCreditSince!;

    recordAiFailure(ref, quotaError());
    await drainAiUsageWrites();

    expect((await statusOf("openai"))!.outOfCreditSince).toEqual(first);
  });
});

describe("the AI gateway", () => {
  it("records tokens against the AI job that made the call", async () => {
    createCompletion.mockResolvedValue({
      choices: [{ message: { content: "{}" } }],
      usage: { prompt_tokens: 321, completion_tokens: 45 },
    });
    createEmbedding.mockResolvedValue({ data: [], usage: { prompt_tokens: 12 } });

    await complete("job_post_writer", { messages: [{ role: "user", content: "hi" }] });
    await embed("cv_matching", { input: "a CV" });
    await drainAiUsageWrites();

    const rows = await usageRows();
    expect(rows.map((row) => [row.feature, row.inputTokens, row.outputTokens])).toEqual([
      ["cv_matching", "12", "0"],
      ["job_post_writer", "321", "45"],
    ]);
  });

  it("doesn't retry an account out of credit, tells users neutrally, and flags the provider", async () => {
    createCompletion.mockRejectedValue(quotaError());

    const call = complete("job_post_writer", { messages: [{ role: "user", content: "hi" }] });

    await expect(call).rejects.toBeInstanceOf(AiCreditError);
    await expect(call).rejects.toMatchObject({
      statusCode: 503,
      message: "AI features are briefly unavailable. Please try again later.",
    });
    expect(createCompletion).toHaveBeenCalledTimes(1);
    await drainAiUsageWrites();
    expect((await statusOf("openai"))?.outOfCreditSince).toBeInstanceOf(Date);
  });
});

describe("provider balances", () => {
  const replies = (deepseek: unknown, elevenlabs: unknown) =>
    axiosGet.mockImplementation((url: string) => {
      const body = url.includes("deepseek") ? deepseek : elevenlabs;
      return body instanceof Error ? Promise.reject(body) : Promise.resolve({ data: body });
    });

  beforeEach(() => {
    process.env["DEEPSEEK_API_KEY"] = "deepseek-test-key";
    axiosGet.mockReset();
  });

  afterEach(() => {
    delete process.env["DEEPSEEK_API_KEY"];
  });

  it("stores what is left on DeepSeek and ElevenLabs, at most once an hour", async () => {
    replies(
      { is_available: true, balance_infos: [{ currency: "USD", total_balance: "42.50" }] },
      { character_count: 9_000, character_limit: 100_000 }
    );

    expect((await checkProviderBalances({ force: true })).checked).toEqual([
      "deepseek",
      "elevenlabs",
    ]);
    expect(await checkProviderBalances({ force: true })).toEqual({ checked: [] });

    expect(axiosGet).toHaveBeenCalledTimes(2);
    expect(await statusOf("deepseek")).toMatchObject({ balance: "42.5000", balanceUnit: "USD" });
    expect(await statusOf("elevenlabs")).toMatchObject({
      balance: "91000.0000",
      balanceUnit: "characters",
      outOfCreditSince: null,
    });
  });

  it("marks an empty account out of credit, and a topped-up one back in", async () => {
    replies(
      { is_available: false, balance_infos: [{ currency: "USD", total_balance: "0.00" }] },
      { character_count: 100_000, character_limit: 100_000 }
    );
    await checkProviderBalances({ force: true });
    expect((await statusOf("deepseek"))?.outOfCreditSince).toBeInstanceOf(Date);
    expect((await statusOf("elevenlabs"))?.outOfCreditSince).toBeInstanceOf(Date);

    await testDataSource.query(`UPDATE ai_provider_status SET balance_checked_at = NULL`);
    replies(
      { is_available: true, balance_infos: [{ currency: "USD", total_balance: "10.00" }] },
      { character_count: 0, character_limit: 100_000 }
    );
    await checkProviderBalances({ force: true });
    expect((await statusOf("deepseek"))?.outOfCreditSince).toBeNull();
    expect((await statusOf("elevenlabs"))?.outOfCreditSince).toBeNull();
  });

  it("leaves no balance when the provider can't be asked, without touching the credit status", async () => {
    recordAiFailure({ provider: "deepseek", model: "deepseek-chat", feature: "x" }, quotaError());
    await drainAiUsageWrites();
    replies(new Error("timeout"), new Error("401"));

    await checkProviderBalances({ force: true });

    const deepseek = await statusOf("deepseek");
    expect(deepseek?.balance).toBeNull();
    expect(deepseek?.outOfCreditSince).toBeInstanceOf(Date);
  });
});
