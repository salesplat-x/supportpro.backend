/**
 * AI Config CRUD tests — recruiter isolation, stage computation, ownership.
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import { startTestDatabase, stopTestDatabase, clearAllTables } from "./helpers/db.js";
import { createTalent, createRecruiter, createAdmin, createAIConfig } from "./helpers/fixtures.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
  })),
}));

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

afterEach(async () => {
  await clearAllTables();
  jest.clearAllMocks();
});

const baseConfigBody = {
  name: "Test Config",
  prescreeningAssessment: true,
  minPrescreeningScore: 60,
  cvSimilarity: true,
  minCvSimilarityScore: 50,
  noOfCvSimilarCandidates: 10,
  personalizedAssessment: true,
  noPersonalizedQuestions: 2,
  personalityEvaluation: true,
  noOfEIQuestions: 3,
};

// ---------------------------------------------------------------------------
// POST /v1/ai-config/ — create AI config (Recruiter/Admin)
// ---------------------------------------------------------------------------

describe("POST /v1/ai-config/ — create AI config", () => {
  it("Recruiter creates a config → 201", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send(baseConfigBody);
    expect(res.status).toBe(201);
    expect(res.body.data.aiConfig).toBeDefined();
  });

  it("Admin can create config → 201", async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...baseConfigBody, name: "Admin Config" });
    expect(res.status).toBe(201);
  });

  it("Talent cannot create → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send(baseConfigBody);
    expect(res.status).toBe(403);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app).post("/v1/ai-config/").send(baseConfigBody);
    expect(res.status).toBe(401);
  });

  it("Stages are computed from assessment flags on create", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        ...baseConfigBody,
        prescreeningAssessment: true,
        cvSimilarity: true,
        personalizedAssessment: false,
        personalityEvaluation: false,
      });
    expect(res.status).toBe(201);
    const stages = res.body.data.aiConfig.stages;
    expect(stages).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// GET /v1/ai-config/ — list AI configs (Recruiter/Admin)
// ---------------------------------------------------------------------------

describe("GET /v1/ai-config/ — list AI configs", () => {
  it("Recruiter sees their own configs → 200", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const { user: recruiter2 } = await createRecruiter();

    await createAIConfig(recruiter);
    await createAIConfig(recruiter2);

    const res = await request(app)
      .get("/v1/ai-config/")
      .set("Authorization", `Bearer ${recruiterToken}`);

    expect(res.status).toBe(200);
    const configs = res.body.data.aiConfigs ?? res.body.data ?? [];
    expect(Array.isArray(configs)).toBe(true);
    expect(configs.every((c: { recruiterId: string }) => c.recruiterId === recruiter.id)).toBe(
      true
    );
  });

  it("Talent cannot access → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app).get("/v1/ai-config/").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app).get("/v1/ai-config/");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/ai-config/:_id — single AI config (Recruiter/Admin)
// ---------------------------------------------------------------------------

describe("GET /v1/ai-config/:_id — single AI config", () => {
  it("Owner recruiter fetches their config → 200", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const config = await createAIConfig(recruiter);

    const res = await request(app)
      .get(`/v1/ai-config/${config.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("Another recruiter cannot fetch → 403", async () => {
    const { user: recruiter } = await createRecruiter();
    const { token: otherToken } = await createRecruiter();
    const config = await createAIConfig(recruiter);

    const res = await request(app)
      .get(`/v1/ai-config/${config.id}`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(403);
  });

  it("Non-existent → 404", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .get("/v1/ai-config/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/ai-config/:_id — update AI config (Recruiter/Admin)
// ---------------------------------------------------------------------------

describe("PATCH /v1/ai-config/:_id — update AI config", () => {
  it("Owner recruiter updates their config → 200", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const config = await createAIConfig(recruiter, { name: "Old Name" });

    const res = await request(app)
      .patch(`/v1/ai-config/${config.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Updated Name" });

    expect(res.status).toBe(200);
    expect(res.body.data.aiConfig).toBeDefined();
  });

  it("Non-owner recruiter cannot update → 403", async () => {
    const { user: recruiter } = await createRecruiter();
    const { token: otherToken } = await createRecruiter();
    const config = await createAIConfig(recruiter);

    const res = await request(app)
      .patch(`/v1/ai-config/${config.id}`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ name: "Hack" });
    expect(res.status).toBe(403);
  });

  it("Non-existent → 404", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .patch("/v1/ai-config/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "X" });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/ai-config/:_id — delete AI config (Recruiter/Admin)
// ---------------------------------------------------------------------------

describe("DELETE /v1/ai-config/:_id — delete AI config", () => {
  it("Owner recruiter deletes their config → 200", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const config = await createAIConfig(recruiter);

    const res = await request(app)
      .delete(`/v1/ai-config/${config.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("Non-owner recruiter cannot delete → 403", async () => {
    const { user: recruiter } = await createRecruiter();
    const { token: otherToken } = await createRecruiter();
    const config = await createAIConfig(recruiter);

    const res = await request(app)
      .delete(`/v1/ai-config/${config.id}`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(403);
  });

  it("Non-existent → 404", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .delete("/v1/ai-config/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("Talent cannot delete → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .delete("/v1/ai-config/some-id")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
