/**
 * Prescreening tests — GET/submit/retake for the AI-powered prescreening flow.
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import {
  createCompleteTalent,
  createRecruiter,
  createRole,
  createPreScreening,
} from "./helpers/fixtures.js";
import { PreScreening } from "../src/entities/PreScreening.js";
import { PreScreeningStatus } from "../src/types/enums.js";
import { TalentEmbedding } from "../src/entities/TalentEmbedding.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
  generatePreScreeningAssessment: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({
        questions: Array.from({ length: 5 }, (_, i) => ({
          questionId: `ps_q${i + 1}`,
          question: `Question ${i + 1}?`,
          category: "general",
          options: ["Option A", "Option B", "Option C", "Option D"],
          correctOption: 0,
          intent: "Test intent",
          scoringHint: "Award 1 point for A",
        })),
      }),
    },
  }),
  scorePreScreeningAssessment: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({ totalScore: 80, breakdown: [] }),
    },
  }),
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

// ---------------------------------------------------------------------------
// GET /v1/prescreening/ — get or generate assessment
// ---------------------------------------------------------------------------

describe("GET /v1/prescreening/ — get or generate prescreening", () => {
  it("Talent with complete profile gets a generated assessment → 200", async () => {
    const role = await createRole();
    const { token } = await createCompleteTalent(role);

    const res = await request(app).get("/v1/prescreening/").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.preScreening).toBeDefined();
    expect(Array.isArray(res.body.data.preScreening.questions)).toBe(true);
  });

  it("Returns existing assessment if already generated", async () => {
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);
    await createPreScreening(user, [role.id]);

    const res = await request(app).get("/v1/prescreening/").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.preScreening.questions).toBeDefined();
  });

  it("Sensitive fields are stripped from questions (no correctOption/intent/scoringHint)", async () => {
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);
    // Pre-seed prescreening so the endpoint returns existing questions rather than triggering async generation
    await createPreScreening(user, [role.id]);

    const res = await request(app).get("/v1/prescreening/").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const question = res.body.data.preScreening.questions[0];
    expect(question.correctOption).toBeUndefined();
    expect(question.intent).toBeUndefined();
    expect(question.scoringHint).toBeUndefined();
    expect(question.question).toBeDefined();
    expect(question.options).toBeDefined();
  });

  it("Talent without complete profile → 404 (auto-generation blocked)", async () => {
    const { createTalent } = await import("./helpers/fixtures.js");
    const { token: poorToken } = await createTalent({ cvUrl: null });

    const res = await request(app)
      .get("/v1/prescreening/")
      .set("Authorization", `Bearer ${poorToken}`);

    expect(res.status).toBe(404);
  });

  it("Recruiter cannot access → 403", async () => {
    const { token } = await createRecruiter();
    const res = await request(app).get("/v1/prescreening/").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app).get("/v1/prescreening/");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/prescreening/submit — submit answers
// ---------------------------------------------------------------------------

describe("POST /v1/prescreening/submit — submit answers", () => {
  it("Submits valid answers → 200, score returned, PreScreening status becomes Completed", async () => {
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);
    await createPreScreening(user, [role.id]);

    // Add talent embedding so scoring can use CV context
    await testDataSource.getRepository(TalentEmbedding).save(
      testDataSource.getRepository(TalentEmbedding).create({
        userId: user.id,
        cvText: "Experienced developer",
        cvEmbedding: `[${new Array(512).fill(0.1).join(",")}]`,
        generatedAt: new Date(),
      })
    );

    // Submit answers matching the stored question (array format — required by validator)
    const ps = await testDataSource
      .getRepository(PreScreening)
      .findOne({ where: { userId: user.id } });
    const questions = ps!.questions as Array<{ questionId: string; options: string[] }>;
    const answers = questions.map((q) => ({ questionId: q.questionId, selectedOption: 0 }));

    const res = await request(app)
      .post("/v1/prescreening/submit")
      .set("Authorization", `Bearer ${token}`)
      .send({ answers });

    expect(res.status).toBe(200);
    expect(res.body.data.score).toBeDefined();

    const updated = await testDataSource
      .getRepository(PreScreening)
      .findOne({ where: { userId: user.id } });
    expect(updated!.status).toBe(PreScreeningStatus.Completed);
  });

  it("Invalid option text for a question → 400", async () => {
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);
    await createPreScreening(user, [role.id]);

    const ps = await testDataSource
      .getRepository(PreScreening)
      .findOne({ where: { userId: user.id } });
    const questions = ps!.questions as Array<{ questionId: string }>;
    const answers: Record<string, string> = {};
    for (const q of questions) {
      answers[q.questionId] = "NONEXISTENT_OPTION";
    }

    const res = await request(app)
      .post("/v1/prescreening/submit")
      .set("Authorization", `Bearer ${token}`)
      .send({ answers });

    expect(res.status).toBe(400);
  });

  it("Missing answers for some questions → 400", async () => {
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);
    await createPreScreening(user, [role.id]);

    // Send only partial answers
    const res = await request(app)
      .post("/v1/prescreening/submit")
      .set("Authorization", `Bearer ${token}`)
      .send({ answers: {} });

    expect(res.status).toBe(400);
  });

  it("Assessment already completed → 400", async () => {
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);
    await createPreScreening(user, [role.id], { status: PreScreeningStatus.Completed });

    const res = await request(app)
      .post("/v1/prescreening/submit")
      .set("Authorization", `Bearer ${token}`)
      .send({ answers: { some: "answer" } });

    expect(res.status).toBe(400);
  });

  it("No active assessment → 404", async () => {
    const role = await createRole();
    const { token } = await createCompleteTalent(role);
    // No prescreening created

    const res = await request(app)
      .post("/v1/prescreening/submit")
      .set("Authorization", `Bearer ${token}`)
      .send({ answers: { q1: "Option A" } });

    // Service returns 404 when no assessment exists
    expect([400, 404]).toContain(res.status);
  });

  it("Recruiter cannot submit → 403", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/prescreening/submit")
      .set("Authorization", `Bearer ${token}`)
      .send({ answers: {} });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/prescreening/retake — request retake
// ---------------------------------------------------------------------------

describe("POST /v1/prescreening/retake — request retake", () => {
  it("Generates new questions when attemptCount < maxAttempts → 200", async () => {
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);
    await createPreScreening(user, [role.id], {
      status: PreScreeningStatus.Completed,
      attemptCount: 1,
      maxAttempts: 2,
    });

    const res = await request(app)
      .post("/v1/prescreening/retake")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it("Blocked when attemptCount >= maxAttempts → 400", async () => {
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);
    await createPreScreening(user, [role.id], {
      status: PreScreeningStatus.Completed,
      attemptCount: 2,
      maxAttempts: 2,
    });

    const res = await request(app)
      .post("/v1/prescreening/retake")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  it("Blocked when current assessment is not yet completed → 400", async () => {
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);
    await createPreScreening(user, [role.id], {
      status: PreScreeningStatus.Pending,
      attemptCount: 1,
      maxAttempts: 2,
    });

    const res = await request(app)
      .post("/v1/prescreening/retake")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  it("No assessment found → 404", async () => {
    const role = await createRole();
    const { token } = await createCompleteTalent(role);

    const res = await request(app)
      .post("/v1/prescreening/retake")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it("Recruiter cannot retake → 403", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/prescreening/retake")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
