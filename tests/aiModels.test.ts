const createCompletion = jest.fn();
const createEmbedding = jest.fn();

jest.mock("openai", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: createCompletion } },
    embeddings: { create: createEmbedding },
  })),
}));

import request from "supertest";
import OpenAI from "openai";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { createAdmin, createTalent } from "./helpers/fixtures.js";
import { apiData } from "./helpers/http.js";
import { AiFeatureSetting } from "../src/entities/AiFeatureSetting.js";
import {
  AI_FEATURE_KEYS,
  AiCatalog,
  AiModel,
  loadAiCatalog,
  validateAiCatalog,
} from "../src/utils/integrations/ai/catalog.js";
import { buildChatRequest } from "../src/utils/integrations/ai/gateway.js";
import { clearAiSettingsCache } from "../src/utils/integrations/ai/settings.js";
import { createEmbedding as embedText, efficiencyTip } from "../src/utils/integrations/openai.js";
import { durableFailureUpdate, MAX_DURABLE_ATTEMPTS } from "../src/utils/durableJobs.js";
import { AiConfigError } from "../src/utils/errors";
import type { AiFeatureView, AiModelsOverview } from "../src/services/aiModels.js";

const passingReply = { choices: [{ message: { content: '{"ok":true}' } }] };

let app: ReturnType<typeof createApp>;

const getOverview = async (token: string) => {
  const res = await request(app).get("/v1/admin/ai-models").set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return apiData<AiModelsOverview>(res);
};

const featureIn = (overview: AiModelsOverview, key: string): AiFeatureView =>
  overview.features.find((feature) => feature.key === key)!;

const choose = (token: string, key: string, provider: string, model: string) =>
  request(app)
    .patch(`/v1/admin/ai-models/features/${key}`)
    .set("Authorization", `Bearer ${token}`)
    .send({ provider, model });

const tipInput = {
  jobTitle: "Support lead",
  breakdown: {},
} as unknown as Parameters<typeof efficiencyTip>[0];

const lastRequest = () => createCompletion.mock.lastCall?.[0] as Record<string, unknown>;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

beforeEach(() => {
  createCompletion.mockReset();
  createCompletion.mockResolvedValue(passingReply);
  createEmbedding.mockReset();
  createEmbedding.mockResolvedValue({ data: [{ embedding: new Array(512).fill(0.1) }] });
  clearAiSettingsCache();
  process.env["GEMINI_API_KEY"] = "gemini-test-key";
  process.env["DEEPSEEK_API_KEY"] = "deepseek-test-key";
});

afterEach(async () => {
  delete process.env["GEMINI_API_KEY"];
  delete process.env["DEEPSEEK_API_KEY"];
  await clearAllTables();
});

describe("catalogue", () => {
  it("loads, and names every AI job in the code", () => {
    const catalog = loadAiCatalog();
    expect(catalog.features.map((feature) => feature.key).sort()).toEqual(
      [...AI_FEATURE_KEYS].sort()
    );
    expect(catalog.features.find((feature) => feature.key === "cv_matching")?.name).toBe(
      "CV matching AI"
    );
  });

  it("refuses a job whose default model can't do it", () => {
    const catalog = loadAiCatalog();
    const broken: AiCatalog = {
      ...catalog,
      features: catalog.features.map((feature) =>
        feature.key === "goal_suggestions"
          ? { ...feature, default: { provider: "deepseek", model: "deepseek-flash" } }
          : feature
      ),
    };
    expect(() => validateAiCatalog(broken)).toThrow(/goal_suggestions can't use its default/);
  });
});

describe("buildChatRequest", () => {
  const messages = [{ role: "user" as const, content: "Hi" }];
  const modelOf = (id: string): AiModel => loadAiCatalog().models.find((item) => item.id === id)!;

  it("leaves a gpt-4o request exactly as it was", () => {
    expect(buildChatRequest(modelOf("gpt-4o"), { messages, max_tokens: 300, temperature: 0 })).toEqual({
      messages,
      model: "gpt-4o",
      max_tokens: 300,
      temperature: 0,
    });
  });

  it("drops temperature and raises the output cap on a model that reasons", () => {
    expect(
      buildChatRequest(modelOf("gpt-6.1-sol"), { messages, max_tokens: 300, temperature: 0 })
    ).toEqual({
      messages,
      model: "gpt-6.1-sol",
      max_completion_tokens: 4000,
      reasoning_effort: "low",
    });
  });

  it("turns reasoning off where the model allows it", () => {
    expect(buildChatRequest(modelOf("gpt-6-luna"), { messages, max_tokens: 300 })).toEqual({
      messages,
      model: "gpt-6-luna",
      max_completion_tokens: 300,
      reasoning_effort: "none",
    });
  });
});

describe("GET /v1/admin/ai-models", () => {
  it("refuses anyone but the admin", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .get("/v1/admin/ai-models")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("shows which providers have a key, and never the key itself", async () => {
    const { token } = await createAdmin();
    delete process.env["GROK_API_KEY"];

    const overview = await getOverview(token);

    const byKey = new Map(overview.providers.map((provider) => [provider.key, provider]));
    expect(byKey.get("gemini")?.configured).toBe(true);
    expect(byKey.get("grok")?.configured).toBe(false);
    expect(JSON.stringify(overview)).not.toContain("gemini-test-key");
    expect(overview.features).toHaveLength(AI_FEATURE_KEYS.length);
  });

  it("keeps strict jobs away from models without schema support", async () => {
    const { token } = await createAdmin();

    const overview = await getOverview(token);

    const strict = featureIn(overview, "goal_suggestions").options.map((option) => option.model);
    const loose = featureIn(overview, "job_post_writer").options.map((option) => option.model);
    expect(strict).not.toContain("deepseek-flash");
    expect(loose).toContain("deepseek-flash");
  });

  it("only offers a retiring model to a job already on it", async () => {
    const { token } = await createAdmin();

    const overview = await getOverview(token);

    const verdict = featureIn(overview, "applicant_verdict").options.map((option) => option.model);
    const tips = featureIn(overview, "talent_fit_evidence").options.map((option) => option.model);
    expect(verdict).toContain("gpt-4o");
    expect(verdict).not.toContain("gpt-4o-mini");
    expect(tips).toContain("gpt-4o-mini");
    expect(tips).not.toContain("gpt-4o");
  });
});

describe("PATCH /v1/admin/ai-models/features/:key", () => {
  it("saves after a passing test, and the job starts using it", async () => {
    const { token } = await createAdmin();

    const res = await choose(token, "efficiency_tip", "gemini", "gemini-3.6-flash");

    expect(res.status).toBe(200);
    expect(apiData<{ feature: AiFeatureView }>(res).feature.current).toEqual({
      provider: "gemini",
      model: "gemini-3.6-flash",
    });

    await efficiencyTip(tipInput);
    expect(lastRequest()["model"]).toBe("gemini-3.6-flash");
    expect(lastRequest()["max_tokens"]).toBe(4000);
    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
        organization: null,
        project: null,
      })
    );
  });

  it("doesn't save when the model fails its test, and hides the provider's message", async () => {
    const { token } = await createAdmin();
    createCompletion.mockRejectedValue(
      Object.assign(new Error("Incorrect API key provided: gem***key"), { status: 401 })
    );

    const res = await choose(token, "efficiency_tip", "gemini", "gemini-3.6-flash");

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("gem***key");
    expect(await testDataSource.getRepository(AiFeatureSetting).count()).toBe(0);
  });

  it("doesn't save when the reply isn't the JSON we asked for", async () => {
    const { token } = await createAdmin();
    createCompletion.mockResolvedValue({ choices: [{ message: { content: "Sure!" } }] });

    const res = await choose(token, "efficiency_tip", "gemini", "gemini-3.6-flash");

    expect(res.status).toBe(400);
    expect(await testDataSource.getRepository(AiFeatureSetting).count()).toBe(0);
  });

  it("refuses a provider with no key, without calling anything", async () => {
    const { token } = await createAdmin();
    delete process.env["GROK_API_KEY"];

    const res = await choose(token, "efficiency_tip", "grok", "grok-4.7");

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("GROK_API_KEY");
    expect(createCompletion).not.toHaveBeenCalled();
  });

  it("refuses a model that can't do the job", async () => {
    const { token } = await createAdmin();

    const strict = await choose(token, "goal_suggestions", "deepseek", "deepseek-flash");
    const embedding = await choose(token, "job_post_writer", "openai", "text-embedding-3-small");

    expect(strict.status).toBe(400);
    expect(embedding.status).toBe(400);
    expect(createCompletion).not.toHaveBeenCalled();
  });

  it("refuses to move a job onto a retiring model", async () => {
    const { token } = await createAdmin();

    const res = await choose(token, "applicant_verdict", "openai", "gpt-4o-mini");

    expect(res.status).toBe(400);
  });

  it("refuses to change CV matching AI", async () => {
    const { token } = await createAdmin();

    const res = await choose(token, "cv_matching", "gemini", "gemini-embedding-2");

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("can't be compared");
  });

  it("refuses an unknown job and a non-admin", async () => {
    const admin = await createAdmin();
    const talent = await createTalent();

    expect((await choose(admin.token, "made_up", "openai", "gpt-6-luna")).status).toBe(400);
    expect((await choose(talent.token, "efficiency_tip", "openai", "gpt-6-luna")).status).toBe(403);
  });
});

describe("running a job", () => {
  it("uses the catalogue default when nothing is saved", async () => {
    await efficiencyTip(tipInput);
    expect(lastRequest()["model"]).toBe("gpt-4o");
  });

  it("embeds with the CV matching model at 512 dimensions", async () => {
    await embedText("A CV");
    expect(createEmbedding.mock.lastCall?.[0]).toEqual({
      model: "text-embedding-3-small",
      input: "A CV",
      encoding_format: "float",
      dimensions: 512,
    });
  });

  it("falls back to the default when the saved provider's key is removed", async () => {
    const { user, token } = await createAdmin();
    await testDataSource
      .getRepository(AiFeatureSetting)
      .save({ featureKey: "efficiency_tip", provider: "grok", model: "grok-4.7", updatedById: user.id });
    delete process.env["GROK_API_KEY"];

    await efficiencyTip(tipInput);
    expect(lastRequest()["model"]).toBe("gpt-4o");

    const overview = await getOverview(token);
    const feature = featureIn(overview, "efficiency_tip");
    expect(feature.usingDefault).toBe(true);
    expect(feature.notice).toContain("GROK_API_KEY");
  });

  it("ignores a saved choice for a locked job", async () => {
    await testDataSource
      .getRepository(AiFeatureSetting)
      .save({ featureKey: "cv_matching", provider: "gemini", model: "gemini-embedding-2" });

    await embedText("A CV");

    expect((createEmbedding.mock.lastCall?.[0] as { model: string }).model).toBe(
      "text-embedding-3-small"
    );
  });

  it("turns a refused key into a setup error", async () => {
    createCompletion.mockRejectedValue(Object.assign(new Error("Bad key"), { status: 401 }));

    await expect(efficiencyTip(tipInput)).rejects.toBeInstanceOf(AiConfigError);
  });
});

describe("background retries", () => {
  it("doesn't use up an attempt on a setup problem", () => {
    const update = durableFailureUpdate(MAX_DURABLE_ATTEMPTS - 1, new AiConfigError("No key"));
    expect(update.attempts).toBe(MAX_DURABLE_ATTEMPTS - 1);
    expect(update.exhausted).toBe(false);
    expect(update.nextRetryAt).not.toBeNull();
  });

  it("still counts every other failure", () => {
    const update = durableFailureUpdate(MAX_DURABLE_ATTEMPTS - 1, new Error("Timeout"));
    expect(update.attempts).toBe(MAX_DURABLE_ATTEMPTS);
    expect(update.exhausted).toBe(true);
  });
});
