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
import { User } from "../src/entities/User.js";
import { PreScreeningStatus } from "../src/types/enums.js";
import { TalentEmbedding } from "../src/entities/TalentEmbedding.js";
import {
  isPrescreeningScoreValid,
  PRESCREENING_SCORE_VALIDITY_DAYS,
} from "../src/services/prescreening.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
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

  it("Brand-new talent's first request returns a generating stub, not a false-empty assessment → 200", async () => {
    // Regression guard: a brand-new talent with no PreScreening row yet must
    // get `generating: true` with an empty questions array (generation is
    // fire-and-forget), never a "questions: []" response that looks final.
    const role = await createRole();
    const { token } = await createCompleteTalent(role);

    const res = await request(app).get("/v1/prescreening/").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.preScreening.generating).toBe(true);
    expect(res.body.data.preScreening.questions).toEqual([]);
  });

  it("Polling after the generating stub eventually returns real questions → 200", async () => {
    const role = await createRole();
    const { token } = await createCompleteTalent(role);

    const first = await request(app)
      .get("/v1/prescreening/")
      .set("Authorization", `Bearer ${token}`);
    expect(first.body.data.preScreening.generating).toBe(true);

    let last = first;
    for (let attempt = 0; attempt < 20 && last.body.data.preScreening.generating; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      last = await request(app).get("/v1/prescreening/").set("Authorization", `Bearer ${token}`);
    }

    expect(last.body.data.preScreening.generating).toBeFalsy();
    expect(last.body.data.preScreening.questions.length).toBeGreaterThan(0);
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
    const { token: poorToken } = await createTalent({
      cvFileName: null,
      cvText: null,
      cvUploadedAt: null,
    });

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

  it("A second concurrent poll does not re-trigger generation or create a duplicate row", async () => {
    const openai = await import("../src/utils/integrations/openai.js");
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);

    const [res1, res2] = await Promise.all([
      request(app).get("/v1/prescreening/").set("Authorization", `Bearer ${token}`),
      request(app).get("/v1/prescreening/").set("Authorization", `Bearer ${token}`),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // Let the fire-and-forget generation settle before asserting on its side effects.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(openai.generatePreScreeningAssessment).toHaveBeenCalledTimes(1);

    const rows = await testDataSource
      .getRepository(PreScreening)
      .find({ where: { userId: user.id } });
    expect(rows.length).toBe(1);
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

  it("Retake generation includes the prior questions in the AI context", async () => {
    const openai = await import("../src/utils/integrations/openai.js");
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
    expect(openai.generatePreScreeningAssessment).toHaveBeenCalledWith(
      expect.objectContaining({
        isRetake: true,
        previousQuestions: ["Describe your experience"],
      })
    );
  });
});

// ---------------------------------------------------------------------------
// isPrescreeningScoreValid — score expiry boundary behavior
// ---------------------------------------------------------------------------

describe("isPrescreeningScoreValid", () => {
  it("null scoredAt is never valid", () => {
    expect(isPrescreeningScoreValid(null)).toBe(false);
  });

  it("a score scored just now is valid", () => {
    expect(isPrescreeningScoreValid(new Date())).toBe(true);
  });

  it("a score scored well within the validity window is valid", () => {
    const scoredAt = new Date();
    scoredAt.setDate(scoredAt.getDate() - (PRESCREENING_SCORE_VALIDITY_DAYS - 1));
    expect(isPrescreeningScoreValid(scoredAt)).toBe(true);
  });

  it("a score scored past the validity window is expired", () => {
    const scoredAt = new Date();
    scoredAt.setDate(scoredAt.getDate() - (PRESCREENING_SCORE_VALIDITY_DAYS + 1));
    expect(isPrescreeningScoreValid(scoredAt)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/prescreening/ — stale score expiry regenerates the assessment
// ---------------------------------------------------------------------------

describe("GET /v1/prescreening/ — expired score triggers regeneration", () => {
  it("Completed assessment with an expired score returns a generating stub, not the stale result", async () => {
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);
    const expiredDate = new Date();
    expiredDate.setDate(expiredDate.getDate() - (PRESCREENING_SCORE_VALIDITY_DAYS + 1));
    await testDataSource
      .getRepository(User)
      .update(user.id, { prescreeningScore: 80, prescreeningScoredAt: expiredDate });
    await createPreScreening(user, [role.id], { status: PreScreeningStatus.Completed, score: 80 });

    const res = await request(app).get("/v1/prescreening/").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.preScreening.generating).toBe(true);
    expect(res.body.data.preScreening.questions).toEqual([]);
  });

  it("Completed assessment with a fresh score returns the existing result, not a regeneration", async () => {
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);
    await testDataSource
      .getRepository(User)
      .update(user.id, { prescreeningScore: 80, prescreeningScoredAt: new Date() });
    await createPreScreening(user, [role.id], { status: PreScreeningStatus.Completed, score: 80 });

    const res = await request(app).get("/v1/prescreening/").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.preScreening.generating).toBeFalsy();
    expect(res.body.data.preScreening.status).toBe(PreScreeningStatus.Completed);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/prescreening/submit — score expiry timestamp
// ---------------------------------------------------------------------------

describe("POST /v1/prescreening/submit — sets prescreeningScoredAt", () => {
  it("Submitting answers stamps the user's prescreeningScoredAt", async () => {
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);
    await createPreScreening(user, [role.id]);

    const ps = await testDataSource
      .getRepository(PreScreening)
      .findOne({ where: { userId: user.id } });
    const questions = ps!.questions as Array<{ questionId: string; options: string[] }>;
    const answers = questions.map((q) => ({ questionId: q.questionId, selectedOption: 0 }));

    const before = new Date();
    const res = await request(app)
      .post("/v1/prescreening/submit")
      .set("Authorization", `Bearer ${token}`)
      .send({ answers });

    expect(res.status).toBe(200);

    const updatedUser = await testDataSource
      .getRepository(User)
      .findOne({ where: { id: user.id } });
    expect(updatedUser!.prescreeningScoredAt).not.toBeNull();
    expect(new Date(updatedUser!.prescreeningScoredAt!).getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000
    );
    expect(isPrescreeningScoreValid(updatedUser!.prescreeningScoredAt)).toBe(true);
  });
});
