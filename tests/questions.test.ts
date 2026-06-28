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
import { ApplicationStatus, QuestionType, ScreeningStage } from "../src/types/enums.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
  generatePersonalizedQuestions: jest.fn().mockResolvedValue({
    message: { content: JSON.stringify({ questions: ["Q1?", "Q2?"] }) },
  }),
  getPersonalityEvaluationQuestion: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({ question: "Are you E or I?", options: ["Extrovert", "Introvert"] }),
    },
  }),
  gradeAssessmentAnswers: jest.fn().mockImplementation((_questionsJSON: string) => {
    const questions = JSON.parse(_questionsJSON);
    return Promise.resolve({
      message: {
        content: JSON.stringify({
          responses: questions.map((q: { questionId: string }) => ({
            questionId: q.questionId,
            answer: "Test answer",
            score: 4,
          })),
        }),
      },
    });
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
});

// ---------------------------------------------------------------------------
// POST /v1/questions/answer/prescreening — submit prescreening answers (Talent)
// ---------------------------------------------------------------------------

describe("POST /v1/questions/answer/prescreening — submit prescreening answers", () => {
  it("Talent submits valid answers for their role → 200, scorePercent returned", async () => {
    const role = await createRole();
    const { token: talentToken } = await createCompleteTalent(role);

    const q1 = await createQuestion(QuestionType.Prescreening, { roleId: role.id });

    const answers: Record<string, string> = { [q1.id]: "TypeScript is my primary language" };

    const res = await request(app)
      .post("/v1/questions/answer/prescreening")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({ roleId: role.id, answers });

    expect(res.status).toBe(200);
    expect(res.body.data.scorePercent).toBeDefined();
  });

  it("Too many answers (>15) → 400", async () => {
    const role = await createRole();
    const { token } = await createCompleteTalent(role);

    const answers: Record<string, string> = {};
    for (let i = 0; i < 16; i++) answers[`fake-id-${i}`] = "answer";

    const res = await request(app)
      .post("/v1/questions/answer/prescreening")
      .set("Authorization", `Bearer ${token}`)
      .send({ roleId: role.id, answers });

    expect(res.status).toBe(400);
  });

  it("Talent not permitted for that role (not in their userRoles) → 403", async () => {
    const role = await createRole();
    const otherRole = await createRole("other-role");
    const { token } = await createCompleteTalent(role); // talent only has `role`

    const q = await createQuestion(QuestionType.Prescreening, { roleId: otherRole.id });

    const res = await request(app)
      .post("/v1/questions/answer/prescreening")
      .set("Authorization", `Bearer ${token}`)
      .send({ roleId: otherRole.id, answers: { [q.id]: "answer" } });

    expect(res.status).toBe(403);
  });

  it("Profile incomplete → 403", async () => {
    const role = await createRole();
    const { token } = await createTalent(); // no CV

    const res = await request(app)
      .post("/v1/questions/answer/prescreening")
      .set("Authorization", `Bearer ${token}`)
      .send({ roleId: role.id, answers: { "some-id": "answer" } });

    expect(res.status).toBe(403);
  });

  it("Recruiter cannot access → 403", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/questions/answer/prescreening")
      .set("Authorization", `Bearer ${token}`)
      .send({ roleId: "any", answers: {} });
    expect(res.status).toBe(403);
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
    await createApplication(talent, job);

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

  it("Not exactly 4 answers → 400", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, { personalityEvaluation: true });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const { user: talent, token: talentToken } = await createTalent();
    await createApplication(talent, job);

    const q = await createQuestion(QuestionType.Personality, { jobId: job.id });

    const res = await request(app)
      .post("/v1/questions/answer/personality")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({
        jobId: job.id,
        answers: { [q.id]: "Answer" }, // only 1 answer, needs 4
      });

    expect(res.status).toBe(400);
  });

  it("Recruiter cannot submit personality answers → 403", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/questions/answer/personality")
      .set("Authorization", `Bearer ${token}`)
      .send({ jobId: "any", answers: {} });
    expect(res.status).toBe(403);
  });
});
