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
import { CvEmbeddingStatus, PreScreeningStatus, GenerationStatus } from "../src/types/enums.js";
import { TalentEmbedding } from "../src/entities/TalentEmbedding.js";
import {
  drainInFlightPreScreenings,
  ensureDuePreScreenings,
  isPrescreeningScoreValid,
  prepareFirstPreScreening,
  PRESCREENING_SCORE_VALIDITY_DAYS,
  reconcileDueNextPreScreeningSets,
  reconcileDuePreScreeningGenerations,
  refreshPreScreeningForRoles,
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
  await drainInFlightPreScreenings();
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
    expect(res.body.error.code).toBe("PROFILE_INCOMPLETE");
  });

  it("A talent with only a CV and roles gets questions, not a profile error", async () => {
    const role = await createRole();
    const { token } = await createCompleteTalent(role, {
      bio: null,
      experience: null,
      locationCountry: null,
      minSalary: null,
      maxSalary: null,
      workType: [],
    });

    const res = await request(app).get("/v1/prescreening/").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.preScreening.generating).toBe(true);
  });

  it("While the CV text is still being prepared it shows generating and creates nothing", async () => {
    const openai = await import("../src/utils/integrations/openai.js");
    const role = await createRole();
    const { token } = await createCompleteTalent(role, {
      cvEmbeddingStatus: CvEmbeddingStatus.Pending,
    });

    const res = await request(app).get("/v1/prescreening/").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.preScreening).toMatchObject({ id: null, generating: true, questions: [] });
    expect(await testDataSource.getRepository(PreScreening).count()).toBe(0);
    expect(openai.generatePreScreeningAssessment).not.toHaveBeenCalled();
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

    await drainInFlightPreScreenings();

    const firstSetCalls = (openai.generatePreScreeningAssessment as jest.Mock).mock.calls.filter(
      ([context]: Array<{ isRetake: boolean }>) => !context.isRetake
    );
    expect(firstSetCalls).toHaveLength(1);

    const rows = await testDataSource
      .getRepository(PreScreening)
      .find({ where: { userId: user.id } });
    expect(rows.length).toBe(1);
  });

  it("returns generationFailed when generation retries are exhausted", async () => {
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);
    await testDataSource.getRepository(PreScreening).save(
      testDataSource.getRepository(PreScreening).create({
        userId: user.id,
        roles: [role.id],
        questions: [],
        status: PreScreeningStatus.Pending,
        attemptCount: 0,
        maxAttempts: 2,
        generatedAt: new Date(),
        generationStatus: GenerationStatus.Failed,
        generationAttempts: 5,
      })
    );

    const res = await request(app).get("/v1/prescreening/").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.preScreening.generationFailed).toBe(true);
    expect(res.body.data.preScreening.generating).toBeFalsy();
    expect(res.body.data.preScreening.questions).toEqual([]);
  });

  it("POST /retry-generation re-enqueues a failed generation", async () => {
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);
    await testDataSource.getRepository(PreScreening).save(
      testDataSource.getRepository(PreScreening).create({
        userId: user.id,
        roles: [role.id],
        questions: [],
        status: PreScreeningStatus.Pending,
        attemptCount: 0,
        maxAttempts: 2,
        generatedAt: new Date(),
        generationStatus: GenerationStatus.Failed,
        generationAttempts: 5,
      })
    );

    const retry = await request(app)
      .post("/v1/prescreening/retry-generation")
      .set("Authorization", `Bearer ${token}`);
    expect(retry.status).toBe(200);

    let last = retry;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      last = await request(app).get("/v1/prescreening/").set("Authorization", `Bearer ${token}`);
      if (last.body.data.preScreening.questions?.length > 0) break;
    }

    expect(last.body.data.preScreening.questions.length).toBeGreaterThan(0);
    expect(last.body.data.preScreening.generationFailed).toBeFalsy();
  });

  it("POST /retry-generation rejects when generation is not failed", async () => {
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);
    await createPreScreening(user, [role.id]);

    const res = await request(app)
      .post("/v1/prescreening/retry-generation")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
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

// ---------------------------------------------------------------------------
// Questions written ahead of time
// ---------------------------------------------------------------------------

const questionsFor = async (userId: string) =>
  testDataSource.getRepository(PreScreening).findOne({ where: { userId } });

const setRoles = async (userId: string, roleIds: string[]) => {
  await testDataSource.query(`DELETE FROM user_roles WHERE user_id = $1`, [userId]);
  for (const roleId of roleIds) {
    await testDataSource.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [
      userId,
      roleId,
    ]);
  }
};

describe("Pre-assessment questions written ahead of time", () => {
  it("writes the first questions as soon as the CV and roles exist", async () => {
    const role = await createRole();
    const { user } = await createCompleteTalent(role, { bio: null });

    await prepareFirstPreScreening(user.id);
    await drainInFlightPreScreenings();

    const row = await questionsFor(user.id);
    expect(row?.generationStatus).toBe(GenerationStatus.Succeeded);
    expect(row?.questions).toHaveLength(5);
    expect(row?.attemptCount).toBe(1);
  });

  it("waits while the CV text is being prepared", async () => {
    const role = await createRole();
    const { user } = await createCompleteTalent(role, {
      cvEmbeddingStatus: CvEmbeddingStatus.Pending,
    });

    await prepareFirstPreScreening(user.id);

    expect(await questionsFor(user.id)).toBeNull();
  });

  it("the sweep creates rows only for verified talents with a CV, roles and no questions", async () => {
    const role = await createRole();
    const { user: ready } = await createCompleteTalent(role);
    const { user: waiting } = await createCompleteTalent(role, {
      cvEmbeddingStatus: CvEmbeddingStatus.Pending,
    });
    const { user: unverified } = await createCompleteTalent(role, { emailVerifiedAt: null });
    const { user: noRoles } = await createCompleteTalent();
    const { user: alreadyHas } = await createCompleteTalent(role);
    await createPreScreening(alreadyHas, [role.id], {
      generationStatus: GenerationStatus.Succeeded,
    });

    const { created } = await ensureDuePreScreenings();

    expect(created).toBe(1);
    expect((await questionsFor(ready.id))?.generationStatus).toBe(GenerationStatus.Pending);
    expect(await questionsFor(waiting.id)).toBeNull();
    expect(await questionsFor(unverified.id)).toBeNull();
    expect(await questionsFor(noRoles.id)).toBeNull();
  });

  it("the sweep adds nothing while five writes are already queued", async () => {
    const role = await createRole();
    for (let i = 0; i < 5; i++) {
      const { user } = await createCompleteTalent(role);
      await createPreScreening(user, [role.id], { generationStatus: GenerationStatus.Pending });
    }
    const { user: eligible } = await createCompleteTalent(role);

    const { created } = await ensureDuePreScreenings();

    expect(created).toBe(0);
    expect(await questionsFor(eligible.id)).toBeNull();
  });

  it("a role change rewrites questions not yet taken and keeps the attempt count", async () => {
    const role = await createRole();
    const newRole = await createRole();
    const { user } = await createCompleteTalent(role);
    await createPreScreening(user, [role.id], {
      status: PreScreeningStatus.Pending,
      attemptCount: 2,
      generationStatus: GenerationStatus.Succeeded,
    });
    await setRoles(user.id, [newRole.id]);

    await refreshPreScreeningForRoles(user.id);
    await drainInFlightPreScreenings();

    const row = await questionsFor(user.id);
    expect(row?.roles).toEqual([newRole.id]);
    expect(row?.attemptCount).toBe(2);
    expect(row?.generationStatus).toBe(GenerationStatus.Succeeded);
    expect(row?.questions).toHaveLength(5);
  });

  it("a role change never wipes a taken result", async () => {
    const role = await createRole();
    const newRole = await createRole();
    const { user } = await createCompleteTalent(role);
    await createPreScreening(user, [role.id], {
      status: PreScreeningStatus.Completed,
      score: 80,
      generationStatus: GenerationStatus.Succeeded,
    });
    await setRoles(user.id, [newRole.id]);

    await refreshPreScreeningForRoles(user.id);
    await drainInFlightPreScreenings();

    const row = await questionsFor(user.id);
    expect(row?.status).toBe(PreScreeningStatus.Completed);
    expect(row?.score).toBe(80);
    expect(row?.roles).toEqual([role.id]);
  });

  it("questions written for roles the talent has since changed are not saved", async () => {
    const openai = await import("../src/utils/integrations/openai.js");
    const generate = openai.generatePreScreeningAssessment as jest.Mock;
    const original = generate.getMockImplementation()!;
    const role = await createRole();
    const newRole = await createRole();
    const { user } = await createCompleteTalent(role);
    generate.mockImplementationOnce(async (...args: unknown[]) => {
      await setRoles(user.id, [newRole.id]);
      return original(...args);
    });

    await prepareFirstPreScreening(user.id);
    await drainInFlightPreScreenings();

    const row = await questionsFor(user.id);
    expect(row?.generationStatus).toBe(GenerationStatus.Pending);
    expect(row?.questions).toEqual([]);
  });

  it("saving roles for the first time through PATCH /user/me starts the first questions", async () => {
    const role = await createRole();
    const { user, token } = await createCompleteTalent();

    const res = await request(app)
      .patch("/v1/user/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ roleIds: [role.id] });
    expect(res.status).toBe(200);

    let row = await questionsFor(user.id);
    for (let attempt = 0; attempt < 40 && !row; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      row = await questionsFor(user.id);
    }
    await drainInFlightPreScreenings();
    expect(row).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The next set — questions for the next attempt, ready before the talent asks
// ---------------------------------------------------------------------------

interface NextSet {
  nextQuestions: Array<{ question: string }> | null;
  nextRoles: string | null;
  nextGenerationStatus: string | null;
  nextGenerationLockedAt: Date | null;
}

const nextSetFor = async (userId: string): Promise<NextSet> => {
  const [row] = (await testDataSource.query(
    `SELECT "nextQuestions", "nextRoles", "nextGenerationStatus", "nextGenerationLockedAt"
     FROM pre_screenings WHERE user_id = $1`,
    [userId]
  )) as NextSet[];
  return row!;
};

const NEXT_QUESTIONS = Array.from({ length: 6 }, (_, i) => ({
  questionId: `next_q${i + 1}`,
  question: `Next question ${i + 1}?`,
  category: "general",
  options: ["A", "B", "C", "D"],
  correctOption: 1,
  intent: "next",
}));

const giveReadyNextSet = async (userId: string, roleIds: string[]) => {
  await testDataSource.query(
    `UPDATE pre_screenings SET "nextQuestions" = $2::jsonb, "nextRoles" = $3,
       "nextGenerationStatus" = 'succeeded' WHERE user_id = $1`,
    [userId, JSON.stringify(NEXT_QUESTIONS), [...roleIds].sort().join(",")]
  );
};

describe("Pre-assessment next set", () => {
  it("is written right after the first questions", async () => {
    const role = await createRole();
    const { user } = await createCompleteTalent(role);

    await prepareFirstPreScreening(user.id);
    await drainInFlightPreScreenings();

    const next = await nextSetFor(user.id);
    expect(next.nextGenerationStatus).toBe("succeeded");
    expect(next.nextQuestions).toHaveLength(5);
    expect(next.nextRoles).toBe(role.id);
  });

  it("a retake swaps the ready set in without waiting on the AI", async () => {
    const openai = await import("../src/utils/integrations/openai.js");
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);
    await createPreScreening(user, [role.id], {
      status: PreScreeningStatus.Completed,
      score: 40,
      attemptCount: 1,
      generationStatus: GenerationStatus.Succeeded,
    });
    await giveReadyNextSet(user.id, [role.id]);

    const res = await request(app)
      .post("/v1/prescreening/retake")
      .set("Authorization", `Bearer ${token}`);
    await drainInFlightPreScreenings();

    expect(res.status).toBe(200);
    expect(openai.generatePreScreeningAssessment).not.toHaveBeenCalled();
    const row = await questionsFor(user.id);
    expect(row).toMatchObject({
      status: PreScreeningStatus.Pending,
      score: null,
      attemptCount: 2,
      roles: [role.id],
    });
    expect(row?.questions.map((q) => q.questionId)).toEqual(
      NEXT_QUESTIONS.map((q) => q.questionId)
    );
    expect((await nextSetFor(user.id)).nextGenerationStatus).toBeNull();
  });

  it("two retake clicks at once use only one attempt", async () => {
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);
    await createPreScreening(user, [role.id], {
      status: PreScreeningStatus.Completed,
      attemptCount: 1,
      generationStatus: GenerationStatus.Succeeded,
    });
    await giveReadyNextSet(user.id, [role.id]);

    const responses = await Promise.all([
      request(app).post("/v1/prescreening/retake").set("Authorization", `Bearer ${token}`),
      request(app).post("/v1/prescreening/retake").set("Authorization", `Bearer ${token}`),
    ]);
    await drainInFlightPreScreenings();

    expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
    expect((await questionsFor(user.id))?.attemptCount).toBe(2);
  });

  it("a set written for roles the talent has since changed is not used", async () => {
    const openai = await import("../src/utils/integrations/openai.js");
    const oldRole = await createRole();
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);
    await createPreScreening(user, [oldRole.id], {
      status: PreScreeningStatus.Completed,
      attemptCount: 1,
      generationStatus: GenerationStatus.Succeeded,
    });
    await giveReadyNextSet(user.id, [oldRole.id]);

    const res = await request(app)
      .post("/v1/prescreening/retake")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(openai.generatePreScreeningAssessment).toHaveBeenCalledTimes(1);
    const row = await questionsFor(user.id);
    expect(row?.roles).toEqual([role.id]);
    expect(row?.questions.map((q) => q.questionId)).not.toContain("next_q1");
  });

  it("asks the talent to try again while the next set is still being written", async () => {
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);
    await createPreScreening(user, [role.id], {
      status: PreScreeningStatus.Completed,
      attemptCount: 1,
      generationStatus: GenerationStatus.Succeeded,
    });
    await testDataSource.query(
      `UPDATE pre_screenings SET "nextGenerationStatus" = 'pending', "nextGenerationLockedAt" = NOW()
       WHERE user_id = $1`,
      [user.id]
    );

    const res = await request(app)
      .post("/v1/prescreening/retake")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/almost ready/);
    expect((await questionsFor(user.id))?.status).toBe(PreScreeningStatus.Completed);
  });

  it("an expired score starts again on the ready set at attempt one", async () => {
    const openai = await import("../src/utils/integrations/openai.js");
    const role = await createRole();
    const scoredAt = new Date();
    scoredAt.setDate(scoredAt.getDate() - PRESCREENING_SCORE_VALIDITY_DAYS - 5);
    const { user, token } = await createCompleteTalent(role, {
      prescreeningScore: 70,
      prescreeningScoredAt: scoredAt,
    });
    await createPreScreening(user, [role.id], {
      status: PreScreeningStatus.Completed,
      score: 70,
      attemptCount: 2,
      generationStatus: GenerationStatus.Succeeded,
    });
    await giveReadyNextSet(user.id, [role.id]);

    const res = await request(app).get("/v1/prescreening/").set("Authorization", `Bearer ${token}`);
    await drainInFlightPreScreenings();

    expect(res.status).toBe(200);
    expect(res.body.data.preScreening.generating).toBeUndefined();
    expect(res.body.data.preScreening).toMatchObject({ status: "pending", attemptCount: 1 });
    expect(res.body.data.preScreening.questions).toHaveLength(NEXT_QUESTIONS.length);
    expect(openai.generatePreScreeningAssessment).toHaveBeenCalledTimes(1);
  });

  it("a taken assessment is never rewritten in place, even if its last write was left pending", async () => {
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role, {
      prescreeningScore: 65,
      prescreeningScoredAt: new Date(),
    });
    await createPreScreening(user, [role.id], {
      status: PreScreeningStatus.Completed,
      score: 65,
      generationStatus: GenerationStatus.Pending,
    });

    await reconcileDuePreScreeningGenerations();
    const res = await request(app).get("/v1/prescreening/").set("Authorization", `Bearer ${token}`);

    expect(res.body.data.preScreening.generating).toBeUndefined();
    expect(res.body.data.preScreening.score).toBe(65);
    const row = await questionsFor(user.id);
    expect(row?.status).toBe(PreScreeningStatus.Completed);
  });

  it("the sweep writes next sets only where one can be used", async () => {
    const role = await createRole();
    const { user: retakeLeft } = await createCompleteTalent(role);
    await createPreScreening(retakeLeft, [role.id], {
      status: PreScreeningStatus.Completed,
      attemptCount: 1,
      generationStatus: GenerationStatus.Succeeded,
    });
    const { user: noRetakeLeft } = await createCompleteTalent(role, {
      prescreeningScore: 70,
      prescreeningScoredAt: new Date(),
    });
    await createPreScreening(noRetakeLeft, [role.id], {
      status: PreScreeningStatus.Completed,
      attemptCount: 2,
      generationStatus: GenerationStatus.Succeeded,
    });
    const expiringAt = new Date();
    expiringAt.setDate(expiringAt.getDate() - PRESCREENING_SCORE_VALIDITY_DAYS + 3);
    const { user: expiringSoon } = await createCompleteTalent(role, {
      prescreeningScore: 70,
      prescreeningScoredAt: expiringAt,
    });
    await createPreScreening(expiringSoon, [role.id], {
      status: PreScreeningStatus.Completed,
      attemptCount: 2,
      generationStatus: GenerationStatus.Succeeded,
    });

    await reconcileDueNextPreScreeningSets();
    await reconcileDueNextPreScreeningSets();

    expect((await nextSetFor(retakeLeft.id)).nextGenerationStatus).toBe("succeeded");
    expect((await nextSetFor(noRetakeLeft.id)).nextGenerationStatus).toBeNull();
    expect((await nextSetFor(expiringSoon.id)).nextGenerationStatus).toBe("succeeded");
  });

  it("a role change on a taken assessment rewrites the next set for the new roles", async () => {
    const role = await createRole();
    const newRole = await createRole();
    const { user } = await createCompleteTalent(role);
    await createPreScreening(user, [role.id], {
      status: PreScreeningStatus.Completed,
      attemptCount: 1,
      generationStatus: GenerationStatus.Succeeded,
    });
    await giveReadyNextSet(user.id, [role.id]);
    await setRoles(user.id, [newRole.id]);

    await refreshPreScreeningForRoles(user.id);
    await drainInFlightPreScreenings();

    const next = await nextSetFor(user.id);
    expect(next.nextGenerationStatus).toBe("succeeded");
    expect(next.nextRoles).toBe(newRole.id);
  });

  it("submitting answers keeps a next set that is already written", async () => {
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);
    await createPreScreening(user, [role.id], { generationStatus: GenerationStatus.Succeeded });
    await giveReadyNextSet(user.id, [role.id]);

    const res = await request(app)
      .post("/v1/prescreening/submit")
      .set("Authorization", `Bearer ${token}`)
      .send({ answers: [{ questionId: "q1", selectedOption: 0 }] });
    await drainInFlightPreScreenings();

    expect(res.status).toBe(200);
    const next = await nextSetFor(user.id);
    expect(next.nextGenerationStatus).toBe("succeeded");
    expect(next.nextQuestions?.[0]?.question).toBe("Next question 1?");
  });
});
