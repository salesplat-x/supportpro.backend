/**
 * Questions tests — question bank CRUD, AI-powered generation,
 * answer submission, and ISSUE-004 / ISSUE-009 documentation.
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
  createTalent,
  createCompleteTalent,
  createRecruiter,
  createAdmin,
  createRole,
  createJob,
  createAIConfig,
  createApplication,
  createQuestion,
} from "./helpers/fixtures.js";
import { TalentEmbedding } from "../src/entities/TalentEmbedding.js";
import { Application } from "../src/entities/Application.js";
import { Job } from "../src/entities/Job.js";
import { Question } from "../src/entities/Question.js";
import { Answer } from "../src/entities/Answer.js";
import { User } from "../src/entities/User.js";
import { ApplicationStatus, QuestionType, ScreeningStage } from "../src/types/enums.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
  generatePersonalizedQuestions: jest.fn().mockResolvedValue({
    message: { content: JSON.stringify({ questions: ["Q1?", "Q2?"] }) },
  }),
  getPersonalityEvaluationQuestion: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({ questions: ["Are you more E or I?"] }),
    },
  }),
  assessApplicationMatch: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({
        verdict: "high",
        reasoning: "Strong overall fit.",
        recommendation: "hire",
      }),
    },
  }),
  gradePersonalizedAnswers: jest.fn().mockImplementation((_answersJSON: string) => {
    const answers = JSON.parse(_answersJSON);
    return Promise.resolve({
      message: {
        content: JSON.stringify({
          responses: answers.map((a: { questionId: string }) => ({
            questionId: a.questionId,
            answer: "Test answer",
            score: 4,
          })),
        }),
      },
    });
  }),
  evaluatePersonalityType: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({
        mbtiType: "INTJ",
        responses: [
          { questionId: "q1", answer: "Introvert", dichotomyPreference: "I" },
          { questionId: "q2", answer: "Sensing", dichotomyPreference: "S" },
          { questionId: "q3", answer: "Thinking", dichotomyPreference: "T" },
          { questionId: "q4", answer: "Judging", dichotomyPreference: "J" },
        ],
      }),
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
// POST /v1/questions/ — create question (Admin only)
// ---------------------------------------------------------------------------

describe("POST /v1/questions/ — create question", () => {
  it("Admin creates a prescreening question for a role → 201", async () => {
    const { token } = await createAdmin();
    const role = await createRole("software-engineer");

    const res = await request(app)
      .post("/v1/questions/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        role: role.id, // validator requires 'role', service uses 'roleId'
        roleId: role.id,
        type: QuestionType.Prescreening,
        question: "Describe your TypeScript experience",
        category: "technical",
        criteria: "Assess depth of TS knowledge",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.question.question).toBe("Describe your TypeScript experience");
  });

  it("Recruiter cannot create questions → 403", async () => {
    const { token } = await createRecruiter();
    const role = await createRole();
    const res = await request(app)
      .post("/v1/questions/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        role: role.id,
        roleId: role.id,
        type: QuestionType.Prescreening,
        question: "Q?",
        category: "cat",
        criteria: "crit",
      });
    expect(res.status).toBe(403);
  });

  it("Talent cannot create questions → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/questions/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        role: "any",
        type: QuestionType.Prescreening,
        question: "Q?",
        category: "cat",
        criteria: "crit",
      });
    expect(res.status).toBe(403);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app).post("/v1/questions/").send({ role: "any" });
    expect(res.status).toBe(401);
  });

  it("Missing question field → 400", async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .post("/v1/questions/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        role: "some-role",
        type: QuestionType.Prescreening,
        category: "cat",
        criteria: "crit",
      });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/questions/ — fetch questions (loginRequired + requireCompletedProfile)
// ---------------------------------------------------------------------------

describe("GET /v1/questions/ — fetch questions", () => {
  it("Talent with complete profile fetches prescreening questions → 200", async () => {
    const role = await createRole();
    const { token } = await createCompleteTalent(role);

    const res = await request(app)
      .get("/v1/questions/")
      .set("Authorization", `Bearer ${token}`)
      .query({ questionType: "prescreening", roleId: role.id });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.questions)).toBe(true);
  });

  it("Talent without CV is blocked by requireCompletedProfile → 403", async () => {
    const role = await createRole();
    const { token } = await createTalent();
    // No CV set

    const res = await request(app)
      .get("/v1/questions/")
      .set("Authorization", `Bearer ${token}`)
      .query({ questionType: "prescreening", roleId: role.id });

    expect(res.status).toBe(403);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app).get("/v1/questions/").query({ questionType: "prescreening" });
    expect(res.status).toBe(401);
  });

  it("Missing questionType → 400", async () => {
    const role = await createRole();
    const { token } = await createCompleteTalent(role);
    const res = await request(app).get("/v1/questions/").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/questions/:_id — fetch single question
// ---------------------------------------------------------------------------

describe("GET /v1/questions/:_id", () => {
  it("Returns question by ID → 200", async () => {
    const role = await createRole();
    const question = await createQuestion(QuestionType.Prescreening, { roleId: role.id });

    const res = await request(app).get(`/v1/questions/${question.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.question.id).toBe(question.id);
  });

  it("Non-existent ID → 404", async () => {
    const res = await request(app).get("/v1/questions/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/questions/personalized — generate personalized questions
// ---------------------------------------------------------------------------

describe("POST /v1/questions/personalized — generate personalized questions", () => {
  it("Recruiter generates personalized questions for a talent → 200", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, {
      personalizedAssessment: true,
      noPersonalizedQuestions: 2,
    });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const { user: talent } = await createTalent();

    // Insert a talent embedding so the service can find CV text
    await testDataSource.getRepository(TalentEmbedding).save(
      testDataSource.getRepository(TalentEmbedding).create({
        userId: talent.id,
        cvText: "Experienced TypeScript developer",
        cvEmbedding: `[${new Array(512).fill(0.1).join(",")}]`,
        generatedAt: new Date(),
      })
    );

    // Create an application so the service can link questions
    await createApplication(talent, job, { recruiterId: recruiter.id });

    const res = await request(app)
      .post("/v1/questions/personalized")
      .set("Authorization", `Bearer ${recruiterToken}`)
      .send({ jobId: job.id, talentId: talent.id });

    expect(res.status).toBe(200);
    expect(res.body.data.questions).toBeDefined();
  });

  it("Job not found → 404", async () => {
    const { token } = await createRecruiter();
    const { user: talent } = await createTalent();
    const res = await request(app)
      .post("/v1/questions/personalized")
      .set("Authorization", `Bearer ${token}`)
      .send({ jobId: "00000000-0000-0000-0000-000000000000", talentId: talent.id });
    expect(res.status).toBe(404);
  });

  it("personalizedAssessment=false on aiConfig → 400", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, { personalizedAssessment: false });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });
    const { user: talent } = await createTalent();

    const res = await request(app)
      .post("/v1/questions/personalized")
      .set("Authorization", `Bearer ${recruiterToken}`)
      .send({ jobId: job.id, talentId: talent.id });
    expect(res.status).toBe(400);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app)
      .post("/v1/questions/personalized")
      .send({ jobId: "any", talentId: "any" });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/questions/personality — generate personality question (Recruiter)
// ---------------------------------------------------------------------------

describe("POST /v1/questions/personality — generate personality question", () => {
  it("Recruiter generates personality question → 200", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, { personalityEvaluation: true });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const res = await request(app)
      .post("/v1/questions/personality")
      .set("Authorization", `Bearer ${recruiterToken}`)
      .send({ jobId: job.id, dichotomyPair: "EI" });

    expect(res.status).toBe(200);
  });

  it("Brand-new job with no persisted AIConfig, count sent in request → 200", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    const res = await request(app)
      .post("/v1/questions/personality")
      .set("Authorization", `Bearer ${recruiterToken}`)
      .send({ jobId: job.id, dichotomyPair: "EI", count: 3 });

    expect(res.status).toBe(200);
  });

  it("Talent cannot access → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/questions/personality")
      .set("Authorization", `Bearer ${token}`)
      .send({ jobId: "any", dichotomyPair: "EI" });
    expect(res.status).toBe(403);
  });

  it("Invalid dichotomyPair → 400", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/questions/personality")
      .set("Authorization", `Bearer ${token}`)
      .send({ jobId: "some-id", dichotomyPair: "XX" });
    expect(res.status).toBe(400);
  });

  it("No question count configured for the dichotomy pair → 400", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, {
      personalityEvaluation: true,
      noOfEIQuestions: null,
    });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const res = await request(app)
      .post("/v1/questions/personality")
      .set("Authorization", `Bearer ${recruiterToken}`)
      .send({ jobId: job.id, dichotomyPair: "EI" });

    expect(res.status).toBe(400);
  });
});

describe("POST /v1/questions/personality/ensure — talent-safe idempotent generation", () => {
  it("Talent can trigger generation (unlike POST /personality, which is recruiter-only) → 200", async () => {
    const { user: recruiter } = await createRecruiter();
    const { token: talentToken } = await createTalent();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, { personalityEvaluation: true });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const res = await request(app)
      .post("/v1/questions/personality/ensure")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({ jobId: job.id });

    expect(res.status).toBe(200);
    expect(res.body.data.questions.length).toBeGreaterThan(0);
  });

  it("does not add more questions to a dichotomy pair that already has some (truly idempotent)", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, { personalityEvaluation: true });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    await createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "EI" });

    const before = await testDataSource
      .getRepository(Question)
      .count({ where: { jobId: job.id, type: QuestionType.Personality, criteria: "EI" } });
    expect(before).toBe(1);

    const res = await request(app)
      .post("/v1/questions/personality/ensure")
      .set("Authorization", `Bearer ${recruiterToken}`)
      .send({ jobId: job.id });

    expect(res.status).toBe(200);
    const after = await testDataSource
      .getRepository(Question)
      .count({ where: { jobId: job.id, type: QuestionType.Personality, criteria: "EI" } });
    expect(after).toBe(1);
  });

  it("generates a pool larger than the configured count for a dichotomy pair", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, {
      personalityEvaluation: true,
      noOfEIQuestions: 3,
      noOfSNQuestions: null,
      noOfTFQuestions: null,
      noOfJPQuestions: null,
    });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const getPersonalityEvaluationQuestion = (
      jest.requireMock("../src/utils/integrations/openai.js") as {
        getPersonalityEvaluationQuestion: jest.Mock;
      }
    ).getPersonalityEvaluationQuestion;
    getPersonalityEvaluationQuestion.mockImplementationOnce(
      (_jobBrief: string, pair: string, count: number) =>
        Promise.resolve({
          message: {
            content: JSON.stringify({
              questions: Array.from({ length: count }, (_, i) => `${pair} question ${i}`),
            }),
          },
        })
    );

    const res = await request(app)
      .post("/v1/questions/personality/ensure")
      .set("Authorization", `Bearer ${recruiterToken}`)
      .send({ jobId: job.id });

    expect(res.status).toBe(200);

    const eiCount = await testDataSource
      .getRepository(Question)
      .count({ where: { jobId: job.id, type: QuestionType.Personality, criteria: "EI" } });
    // configured count is 3; the pool must be generated larger (2x multiplier), not exactly 3.
    expect(eiCount).toBe(6);
  });

  it("rejects when personalityEvaluation is disabled for the job → 400", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, { personalityEvaluation: false });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const res = await request(app)
      .post("/v1/questions/personality/ensure")
      .set("Authorization", `Bearer ${recruiterToken}`)
      .send({ jobId: job.id });

    expect(res.status).toBe(400);
  });

  it("404s for a non-existent job", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/questions/personality/ensure")
      .set("Authorization", `Bearer ${token}`)
      .send({ jobId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/questions/?questionType=personality — per-applicant random subset
// ---------------------------------------------------------------------------

describe("GET /v1/questions/?questionType=personality — per-applicant random subset", () => {
  it("assigns a subset sized to the configured counts and caches it on a repeat call", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, {
      personalityEvaluation: true,
      noOfEIQuestions: 1,
      noOfSNQuestions: 1,
      noOfTFQuestions: null,
      noOfJPQuestions: null,
    });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const { user: talent, token: talentToken } = await createCompleteTalent(role);
    await createApplication(talent, job, { recruiterId: recruiter.id });

    const res1 = await request(app)
      .get("/v1/questions/")
      .set("Authorization", `Bearer ${talentToken}`)
      .query({ questionType: "personality", jobId: job.id, limit: 200, offset: 0 });

    expect(res1.status).toBe(200);
    expect(res1.body.data.questions.length).toBe(2);

    const application = await testDataSource
      .getRepository(Application)
      .findOne({ where: { jobId: job.id, talentId: talent.id } });
    const assignedIds = [...(application?.personalityQuestions ?? [])].sort();
    expect(assignedIds.length).toBe(2);

    const res2 = await request(app)
      .get("/v1/questions/")
      .set("Authorization", `Bearer ${talentToken}`)
      .query({ questionType: "personality", jobId: job.id, limit: 200, offset: 0 });

    expect(res2.status).toBe(200);
    const ids2 = (res2.body.data.questions as { id: string }[]).map((q) => q.id).sort();
    expect(ids2).toEqual(assignedIds);

    // Second call must not have re-sampled — the persisted assignment is unchanged.
    const applicationAfter = await testDataSource
      .getRepository(Application)
      .findOne({ where: { jobId: job.id, talentId: talent.id } });
    expect([...(applicationAfter?.personalityQuestions ?? [])].sort()).toEqual(assignedIds);
  });

  it("draws each applicant's subset only from the job's shared pool, respecting the configured count", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, {
      personalityEvaluation: true,
      noOfEIQuestions: 1,
      noOfSNQuestions: null,
      noOfTFQuestions: null,
      noOfJPQuestions: null,
    });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    // A pre-existing shared pool of 4 EI questions — ensurePersonalityQuestions
    // must leave it alone since it's already non-empty (idempotent fill-only).
    const pool = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        createQuestion(
          QuestionType.Personality,
          { jobId: job.id },
          { criteria: "EI", question: `EI question ${i}` }
        )
      )
    );
    const poolIds = pool.map((q) => q!.id);

    const { user: talentA, token: tokenA } = await createCompleteTalent(role);
    await createApplication(talentA, job, { recruiterId: recruiter.id });
    const { user: talentB, token: tokenB } = await createCompleteTalent(role);
    await createApplication(talentB, job, { recruiterId: recruiter.id });

    const resA = await request(app)
      .get("/v1/questions/")
      .set("Authorization", `Bearer ${tokenA}`)
      .query({ questionType: "personality", jobId: job.id, limit: 200, offset: 0 });
    const resB = await request(app)
      .get("/v1/questions/")
      .set("Authorization", `Bearer ${tokenB}`)
      .query({ questionType: "personality", jobId: job.id, limit: 200, offset: 0 });

    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resA.body.data.questions.length).toBe(1);
    expect(resB.body.data.questions.length).toBe(1);
    expect(poolIds).toContain(resA.body.data.questions[0].id);
    expect(poolIds).toContain(resB.body.data.questions[0].id);

    // Pool itself must remain exactly 4 — no extra generation was triggered.
    const finalPoolCount = await testDataSource
      .getRepository(Question)
      .count({ where: { jobId: job.id, type: QuestionType.Personality, criteria: "EI" } });
    expect(finalPoolCount).toBe(4);
  });

  it("404s when the talent hasn't applied to the job", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, { personalityEvaluation: true });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const { token: talentToken } = await createCompleteTalent(role);

    const res = await request(app)
      .get("/v1/questions/")
      .set("Authorization", `Bearer ${talentToken}`)
      .query({ questionType: "personality", jobId: job.id, limit: 200, offset: 0 });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/questions/answer/prescreening — removed; only /v1/prescreening/submit scores
// ---------------------------------------------------------------------------

describe("POST /v1/questions/answer/prescreening — removed", () => {
  it("is gone, so it can't overwrite the talent's pre-assessment score", async () => {
    const role = await createRole();
    const { user, token } = await createCompleteTalent(role);
    await testDataSource.getRepository(User).update(user.id, { prescreeningScore: 40 });
    const q = await createQuestion(QuestionType.Prescreening, { roleId: role.id });

    const res = await request(app)
      .post("/v1/questions/answer/prescreening")
      .set("Authorization", `Bearer ${token}`)
      .send({ roleId: role.id, answers: { [q.id]: "answer" } });

    expect(res.status).toBe(404);
    const after = await testDataSource.getRepository(User).findOneByOrFail({ id: user.id });
    expect(after.prescreeningScore).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/questions/answer/personalized — ISSUE-004 and ISSUE-009
// ---------------------------------------------------------------------------

describe("POST /v1/questions/answer/personalized — ISSUE-004 and ISSUE-009", () => {
  it("Valid answers for job questions returns 200 with scorePercent", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, {
      personalizedAssessment: true,
      minPrescreeningScore: 60,
      stages: { prescreening: "personalized", personalized: "completed" },
    });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const { user: talent, token: talentToken } = await createTalent({ prescreeningScore: 75 });
    await createApplication(talent, job, {
      stages: { prescreening: "personalized", personalized: "completed" },
      currentStage: ScreeningStage.Personalized,
    });

    const q1 = await createQuestion(QuestionType.Personalized, { jobId: job.id });

    // Configure mock to match the question being sent
    const gradePersonalizedAnswers = (
      jest.requireMock("../src/utils/integrations/openai.js") as {
        gradePersonalizedAnswers: jest.Mock;
      }
    ).gradePersonalizedAnswers;
    gradePersonalizedAnswers.mockResolvedValueOnce({
      message: {
        content: JSON.stringify({
          responses: [{ questionId: q1.id, answer: "Good", score: 4 }],
        }),
      },
    });

    const res = await request(app)
      .post("/v1/questions/answer/personalized")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({ jobId: job.id, answers: { [q1.id]: "Good answer" } });

    expect(res.status).toBe(200);
    expect(res.body.data.scorePercent).toBeDefined();
  });

  it("ISSUE-004: Submitting IDs not belonging to the job fires misleading length error", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, { personalizedAssessment: true });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const { user: talent, token: talentToken } = await createTalent({ prescreeningScore: 75 });
    await createApplication(talent, job, { currentStage: ScreeningStage.Personalized });

    // Create 2 real questions for the job
    const q1 = await createQuestion(QuestionType.Personalized, { jobId: job.id });
    const q2 = await createQuestion(QuestionType.Personalized, { jobId: job.id });

    // Mock AI to return 2 responses (matching the 2 real questions)
    const gradePersonalizedAnswers = (
      jest.requireMock("../src/utils/integrations/openai.js") as {
        gradePersonalizedAnswers: jest.Mock;
      }
    ).gradePersonalizedAnswers;
    gradePersonalizedAnswers.mockResolvedValueOnce({
      message: {
        content: JSON.stringify({
          responses: [
            { questionId: q1.id, answer: "A", score: 4 },
            { questionId: q2.id, answer: "B", score: 3 },
          ],
        }),
      },
    });

    // Submit 4 IDs: 2 valid + 2 non-existent (ISSUE-004 scenario)
    const res = await request(app)
      .post("/v1/questions/answer/personalized")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({
        jobId: job.id,
        answers: {
          [q1.id]: "Answer 1",
          [q2.id]: "Answer 2",
          "00000000-0000-0000-0000-000000000011": "Answer 3",
          "00000000-0000-0000-0000-000000000012": "Answer 4",
        },
      });

    // ISSUE-004: response fails with misleading length error (2 !== 4)
    // instead of "questions do not belong to this job"
    expect(res.status).toBe(400);
    // When ISSUE-004 is fixed, the error message should clearly say questions don't belong to the job
  });

  it("ISSUE-009: minPrescreeningScore is used as personalized threshold", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, {
      personalizedAssessment: true,
      minPrescreeningScore: 90, // This SHOULD only gate prescreening, not personalized (ISSUE-009)
      stages: { prescreening: "personalized", personalized: "completed" },
    });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const { user: talent, token: talentToken } = await createTalent({ prescreeningScore: 95 }); // passes prescreening
    await createApplication(talent, job, {
      stages: { prescreening: "personalized", personalized: "completed" },
      currentStage: ScreeningStage.Personalized,
    });

    const q1 = await createQuestion(QuestionType.Personalized, { jobId: job.id });

    // Mock AI to return low score (e.g., 40% = 2/5)
    const gradePersonalizedAnswers = (
      jest.requireMock("../src/utils/integrations/openai.js") as {
        gradePersonalizedAnswers: jest.Mock;
      }
    ).gradePersonalizedAnswers;
    gradePersonalizedAnswers.mockResolvedValueOnce({
      message: {
        content: JSON.stringify({
          responses: [{ questionId: q1.id, answer: "Weak answer", score: 2 }],
        }),
      },
    });

    const res = await request(app)
      .post("/v1/questions/answer/personalized")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({ jobId: job.id, answers: { [q1.id]: "Weak answer" } });

    expect(res.status).toBe(200);

    // ISSUE-009: minPrescreeningScore=90, actual personalized score=40%
    // The application gets RetakeAssessment because minPrescreeningScore is being misused
    const updatedApp = await testDataSource.getRepository(Application).findOne({
      where: { talentId: talent.id, jobId: job.id },
    });
    // This documents ISSUE-009: the prescreening min score is gating the personalized stage
    expect(updatedApp?.status).toBe(ApplicationStatus.RetakeAssessment);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/questions/answer/personality — evaluate personality (Talent)
// ---------------------------------------------------------------------------

describe("POST /v1/questions/answer/personality — evaluate personality type", () => {
  it("Talent submits 4 personality answers → 200, mbtiType returned", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, {
      personalityEvaluation: true,
      stages: { personality: "completed" },
    });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const { user: talent, token: talentToken } = await createTalent({ prescreeningScore: 75 });
    await createApplication(talent, job, {
      stages: { personality: "completed" },
      currentStage: ScreeningStage.Personality,
    });

    // Create 4 personality questions
    const [q1, q2, q3, q4] = await Promise.all([
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "EI" }),
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "SN" }),
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "TF" }),
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "JP" }),
    ]);

    const res = await request(app)
      .post("/v1/questions/answer/personality")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({
        jobId: job.id,
        answers: {
          [q1!.id]: "Introvert",
          [q2!.id]: "Sensing",
          [q3!.id]: "Thinking",
          [q4!.id]: "Judging",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.mbtiType).toBeDefined();
  });

  it("Answering fewer than all generated questions → 400", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, { personalityEvaluation: true });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const { user: talent, token: talentToken } = await createTalent();
    await createApplication(talent, job, { currentStage: ScreeningStage.Personality });

    // Two questions generated for this job, but only one gets answered.
    const [q1] = await Promise.all([
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "EI" }),
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "SN" }),
    ]);

    const res = await request(app)
      .post("/v1/questions/answer/personality")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({
        jobId: job.id,
        answers: { [q1!.id]: "Answer" },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("You must answer exactly 2 questions");
  });

  it("Answers a non-default total (recruiter-configured counts) → 200", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, {
      personalityEvaluation: true,
      stages: { personality: "completed" },
    });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const { user: talent, token: talentToken } = await createTalent({ prescreeningScore: 75 });
    await createApplication(talent, job, {
      stages: { personality: "completed" },
      currentStage: ScreeningStage.Personality,
    });

    // 6 total questions generated across the 4 pairs — not the old default
    // of 4 — proving the check no longer hardcodes a fixed total.
    const questions = await Promise.all([
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "EI" }),
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "EI" }),
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "SN" }),
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "TF" }),
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "TF" }),
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "JP" }),
    ]);

    const answers = Object.fromEntries(questions.map((q) => [q!.id, "Answer"]));

    const res = await request(app)
      .post("/v1/questions/answer/personality")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({ jobId: job.id, answers });

    expect(res.status).toBe(200);
    expect(res.body.data.mbtiType).toBeDefined();
  });

  it("Talent can submit personality after stage was skipped (catch-up) → 200", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, {
      personalityEvaluation: true,
      stages: {
        personality: "personalized",
        personalized: "completed",
      },
    });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const { user: talent, token: talentToken } = await createTalent({
      prescreeningScore: 75,
    });
    // Application already past personality without an MBTI result (e.g. invitation skip).
    await createApplication(talent, job, {
      stages: {
        personality: "personalized",
        personalized: "completed",
      },
      currentStage: ScreeningStage.Completed,
      mbtiType: null,
    });

    const [q1, q2, q3, q4] = await Promise.all([
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "EI" }),
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "SN" }),
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "TF" }),
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "JP" }),
    ]);

    const res = await request(app)
      .post("/v1/questions/answer/personality")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({
        jobId: job.id,
        answers: {
          [q1!.id]: "Introvert",
          [q2!.id]: "Sensing",
          [q3!.id]: "Thinking",
          [q4!.id]: "Judging",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.mbtiType).toBeDefined();
    expect(res.body.data.score).toBe(res.body.data.mbtiType);
  });

  it("Recruiter cannot submit personality answers → 403", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/questions/answer/personality")
      .set("Authorization", `Bearer ${token}`)
      .send({ jobId: "any", answers: {} });
    expect(res.status).toBe(403);
  });

  it("Accepts an applicant's own sampled subset even when the job pool has more questions → 200", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, {
      personalityEvaluation: true,
      stages: { personality: "cv_similarity" },
    });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const { user: talent, token: talentToken } = await createTalent({ prescreeningScore: 75 });
    const application = await createApplication(talent, job, {
      stages: { personality: "cv_similarity" },
      currentStage: ScreeningStage.Personality,
    });

    const [qEI, qSN, qTF, qJP] = await Promise.all([
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "EI" }),
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "SN" }),
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "TF" }),
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "JP" }),
    ]);
    // An extra pool question that exists for the job but wasn't assigned to this applicant.
    await createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "EI" });

    await testDataSource.getRepository(Application).update(application.id, {
      personalityQuestions: [qEI!.id, qSN!.id, qTF!.id, qJP!.id],
    });

    const res = await request(app)
      .post("/v1/questions/answer/personality")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({
        jobId: job.id,
        answers: {
          [qEI!.id]: "Introvert",
          [qSN!.id]: "Sensing",
          [qTF!.id]: "Thinking",
          [qJP!.id]: "Judging",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.mbtiType).toBeDefined();
  });

  it("Rejects an answer set that doesn't match the applicant's assigned subset → 400", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, { personalityEvaluation: true });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const { user: talent, token: talentToken } = await createTalent();
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Personality,
    });

    const [qA, qB, qOther] = await Promise.all([
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "EI" }),
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "SN" }),
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "TF" }),
    ]);
    await testDataSource
      .getRepository(Application)
      .update(application.id, { personalityQuestions: [qA!.id, qB!.id] });

    const res = await request(app)
      .post("/v1/questions/answer/personality")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({
        jobId: job.id,
        answers: { [qA!.id]: "Answer", [qOther!.id]: "Answer" },
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("One or more questions do not belong to job");
  });

  it("Falls back to the full job-level question set when personalityQuestions was never assigned → 200", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, {
      personalityEvaluation: true,
      stages: { personality: "cv_similarity" },
    });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const { user: talent, token: talentToken } = await createTalent({ prescreeningScore: 75 });
    const application = await createApplication(talent, job, {
      stages: { personality: "cv_similarity" },
      currentStage: ScreeningStage.Personality,
    });
    expect(application.personalityQuestions).toBeFalsy();

    const [q1, q2] = await Promise.all([
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "EI" }),
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "SN" }),
    ]);

    const res = await request(app)
      .post("/v1/questions/answer/personality")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({
        jobId: job.id,
        answers: { [q1!.id]: "Answer", [q2!.id]: "Answer" },
      });

    expect(res.status).toBe(200);
    expect(res.body.data.mbtiType).toBeDefined();
  });

  it("saves the talent's answers under real question ids even when the LLM echoes `question` instead of questionId", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, {
      personalityEvaluation: true,
      personalizedAssessment: true,
      stages: { personality: "personalized", personalized: "completed" },
    });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const { user: talent, token: talentToken } = await createTalent({ prescreeningScore: 75 });
    const q1 = await createQuestion(
      QuestionType.Personalized,
      { jobId: job.id },
      { question: "Walk us through a launch you owned." }
    );
    await createApplication(talent, job, {
      stages: { personality: "personalized", personalized: "completed" },
      currentStage: ScreeningStage.Personalized,
      personalizedQuestions: [q1.id],
    });

    const gradePersonalizedAnswers = (
      jest.requireMock("../src/utils/integrations/openai.js") as {
        gradePersonalizedAnswers: jest.Mock;
      }
    ).gradePersonalizedAnswers;
    gradePersonalizedAnswers.mockResolvedValueOnce({
      message: {
        content: JSON.stringify({
          responses: [{ question: q1.id, answer: "rewritten", score: 4 }],
        }),
      },
    });

    const submitted = "I shipped the billing cutover.";
    const post = await request(app)
      .post("/v1/questions/answer/personalized")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({ jobId: job.id, answers: { [q1.id]: submitted } });
    expect(post.status).toBe(200);

    const stored = await testDataSource.getRepository(Answer).findOne({
      where: { userId: talent.id, jobId: job.id, questionType: QuestionType.Personalized },
    });
    expect(stored?.responses).toEqual([
      expect.objectContaining({ questionId: q1.id, answer: submitted, score: 4 }),
    ]);
  });
});
