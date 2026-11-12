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
import {
  createEmbedding as embedText,
  efficiencyTip,
  generatePersonalizedQuestions,
  gradeAssessmentAnswers,
} from "../src/utils/integrations/openai.js";
import {
  fillPlaceholders,
  getPromptParts,
  loadAiPrompts,
} from "../src/utils/integrations/ai/prompts.js";
import { durableFailureUpdate, MAX_DURABLE_ATTEMPTS } from "../src/utils/durableJobs.js";
import { AiConfigError } from "../src/utils/errors";
import type {
  AiFeatureView,
  AiModelsOverview,
  AiPromptPartView,
} from "../src/services/aiModels.js";

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
    expect(
      buildChatRequest(modelOf("gpt-4o"), { messages, max_tokens: 300, temperature: 0 })
    ).toEqual({
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
    const { user, token } = await createAdmin();
    await testDataSource.getRepository(AiFeatureSetting).save({
      featureKey: "applicant_verdict",
      provider: "openai",
      model: "gpt-4o",
      updatedById: user.id,
    });

    const overview = await getOverview(token);

    const verdict = featureIn(overview, "applicant_verdict").options.map((option) => option.model);
    const tips = featureIn(overview, "talent_fit_evidence").options.map((option) => option.model);
    expect(verdict).toContain("gpt-4o");
    expect(verdict).not.toContain("gpt-4o-mini");
    expect(tips).toContain("gpt-5.6-luna");
    expect(tips).not.toContain("gpt-4o");
    expect(tips).not.toContain("gpt-4o-mini");
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
    expect(lastRequest()["model"]).toBe("gpt-5.6-luna");
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
    await testDataSource.getRepository(AiFeatureSetting).save({
      featureKey: "efficiency_tip",
      provider: "grok",
      model: "grok-4.7",
      updatedById: user.id,
    });
    delete process.env["GROK_API_KEY"];

    await efficiencyTip(tipInput);
    expect(lastRequest()["model"]).toBe("gpt-5.6-luna");

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

describe("prompts", () => {
  const getPrompts = (token: string, key: string) =>
    request(app)
      .get(`/v1/admin/ai-models/features/${key}/prompts`)
      .set("Authorization", `Bearer ${token}`);

  const savePrompts = (token: string, key: string, prompts: Record<string, string>) =>
    request(app)
      .put(`/v1/admin/ai-models/features/${key}/prompts`)
      .set("Authorization", `Bearer ${token}`)
      .send({ prompts });

  const defaultOf = (key: string, part: string) =>
    getPromptParts(key).find((item) => item.key === part)!.text;

  const systemSent = () =>
    (lastRequest()["messages"] as Array<{ role: string; content: string }>)[0]!.content;

  it("has a default prompt for every job that sends one", () => {
    const { jobs } = loadAiPrompts();
    for (const feature of loadAiCatalog().features) {
      expect((jobs[feature.key] ?? []).length > 0).toBe(feature.kind === "chat");
    }
  });

  it("shows the admin each part, its default and what must stay in it", async () => {
    const { token } = await createAdmin();

    const res = await getPrompts(token, "personalized_questions");

    expect(res.status).toBe(200);
    const { prompts } = apiData<{ prompts: AiPromptPartView[] }>(res);
    const system = prompts.find((part) => part.key === "system")!;
    expect(system.edited).toBe(false);
    expect(system.text).toBe(system.defaultText);
    expect(system.variables.map((variable) => variable.name)).toEqual(["questionCount"]);
    expect(system.variables[0]?.description).toBeTruthy();
  });

  it("uses the edited prompt straight away, with its placeholders filled", async () => {
    const { token } = await createAdmin();
    const edited = `Write exactly {{questionCount}} questions. Output JSON only: { "questions": [] }`;

    const res = await savePrompts(token, "personalized_questions", { system: edited });
    expect(res.status).toBe(200);

    await generatePersonalizedQuestions("JD", ["CV"], "Bio", 3, "Guide");
    expect(systemSent()).toBe(`Write exactly 3 questions. Output JSON only: { "questions": [] }`);
  });

  it("goes back to the default when the edit matches it", async () => {
    const { token } = await createAdmin();
    const original = defaultOf("efficiency_tip", "system");
    await savePrompts(token, "efficiency_tip", { system: "Give one short tip." });

    await efficiencyTip(tipInput);
    expect(systemSent()).toBe("Give one short tip.");

    const res = await savePrompts(token, "efficiency_tip", { system: original });
    expect(res.status).toBe(200);
    const { prompts } = apiData<{ prompts: AiPromptPartView[] }>(res);
    expect(prompts[0]?.edited).toBe(false);

    await efficiencyTip(tipInput);
    expect(systemSent()).toBe(original);
  });

  it("keeps the model choice when a prompt is saved, and the prompt when a model is chosen", async () => {
    const { token } = await createAdmin();

    await choose(token, "efficiency_tip", "gemini", "gemini-3.6-flash");
    await savePrompts(token, "efficiency_tip", { system: "Give one short tip." });
    await efficiencyTip(tipInput);
    expect(lastRequest()["model"]).toBe("gemini-3.6-flash");
    expect(systemSent()).toBe("Give one short tip.");

    await choose(token, "efficiency_tip", "gemini", "gemini-3.8-flash");
    await efficiencyTip(tipInput);
    expect(lastRequest()["model"]).toBe("gemini-3.8-flash");
    expect(systemSent()).toBe("Give one short tip.");
  });

  it("refuses text that would break the job", async () => {
    const { token } = await createAdmin();
    const original = defaultOf("personalized_questions", "system");

    const lostPlaceholder = await savePrompts(token, "personalized_questions", {
      system: original.replace("{{questionCount}}", "3"),
    });
    const unknownPlaceholder = await savePrompts(token, "personalized_questions", {
      system: `${original} {{companyName}}`,
    });
    const lostJson = await savePrompts(token, "personality_fit", {
      system: 'Give "personalityFitScore": and "personalityFitReason": as plain words.',
    });
    const lostField = await savePrompts(token, "personality_fit", {
      system: 'Reply with JSON: {"personalityFitScore": 72}',
    });
    const empty = await savePrompts(token, "efficiency_tip", { system: "   " });
    const unknownPart = await savePrompts(token, "efficiency_tip", { made_up: "Text" });

    expect(lostPlaceholder.status).toBe(400);
    expect(JSON.stringify(lostPlaceholder.body)).toContain("{{questionCount}}");
    expect(unknownPlaceholder.status).toBe(400);
    expect(JSON.stringify(unknownPlaceholder.body)).toContain("{{companyName}}");
    expect(lostJson.status).toBe(400);
    expect(JSON.stringify(lostJson.body)).toContain("JSON");
    expect(lostField.status).toBe(400);
    expect(JSON.stringify(lostField.body)).toContain("personalityFitReason");
    expect(empty.status).toBe(400);
    expect(unknownPart.status).toBe(400);
    expect(await testDataSource.getRepository(AiFeatureSetting).count()).toBe(0);
  });

  it("ignores a saved edit that no longer passes, and tells the admin why", async () => {
    const { token } = await createAdmin();
    await testDataSource.getRepository(AiFeatureSetting).save({
      featureKey: "role_answer_grading",
      prompts: { system: "Score these answers." },
    });

    await gradeAssessmentAnswers("[]");
    expect(systemSent()).toBe(defaultOf("role_answer_grading", "system"));

    const res = await getPrompts(token, "role_answer_grading");
    const { prompts } = apiData<{ prompts: AiPromptPartView[] }>(res);
    expect(prompts[0]?.problem).toContain("must still ask for JSON");
  });

  it("never expands a placeholder typed into a candidate's text", () => {
    expect(
      fillPlaceholders("Bio: {{bio}} Count: {{count}}", {
        bio: "I wrote {{count}} $& posts",
        count: 3,
      })
    ).toBe("Bio: I wrote {{count}} $& posts Count: 3");
  });

  it("refuses a job with no prompt, and anyone but the admin", async () => {
    const admin = await createAdmin();
    const talent = await createTalent();

    expect((await getPrompts(admin.token, "cv_matching")).status).toBe(400);
    expect((await getPrompts(talent.token, "efficiency_tip")).status).toBe(403);
    expect((await savePrompts(talent.token, "efficiency_tip", { system: "Hi" })).status).toBe(403);
  });

  it("counts edited parts on the overview", async () => {
    const { token } = await createAdmin();
    await savePrompts(token, "efficiency_tip", { system: "Give one short tip." });

    const overview = await getOverview(token);

    const feature = featureIn(overview, "efficiency_tip");
    expect(feature.promptParts).toBe(1);
    expect(feature.editedPromptParts).toBe(1);
    expect(featureIn(overview, "cv_matching").promptParts).toBe(0);
  });
});
