const createCompletion = jest.fn();
const createEmbedding = jest.fn();

jest.mock("openai", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: createCompletion } },
    embeddings: { create: createEmbedding },
  })),
}));

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
