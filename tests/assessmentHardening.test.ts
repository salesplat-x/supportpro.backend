import request from "supertest";
import { Repository, type ObjectLiteral } from "typeorm";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import {
  createRecruiter,
  createCompleteTalent,
  createAIConfig,
  createApplication,
  createJob,
  createRole,
  createQuestion,
} from "./helpers/fixtures.js";
import type { AIConfig } from "../src/entities/AIConfig.js";
import { Question as QuestionEntity, type Question } from "../src/entities/Question.js";
import { ApplicationStatus, QuestionType, ScreeningStage } from "../src/types/enums.js";
import { Application } from "../src/entities/Application.js";
import { Answer } from "../src/entities/Answer.js";
import * as AI from "../src/utils/integrations/openai.js";
import { apiData } from "./helpers/http.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
  generateProblemSolvingQuestions: jest.fn(),
  gradePersonalizedAnswers: jest.fn(),
  evaluatePersonalityType: jest.fn(),
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

async function jobWithPool(poolSize = 4, configOverrides: Partial<AIConfig> = {}) {
  const { user: recruiter, token: recruiterToken } = await createRecruiter();
  const config = await createAIConfig(recruiter, {
    problemSolvingAssessment: true,
    noOfProblemSolvingQuestions: 3,
    cultureFitAssessment: true,
    noOfCultureFitQuestions: 3,
    ...configOverrides,
  });
  const job = await createJob(recruiter, await createRole(), { aiConfigId: config.id });
  const pool: Question[] = [];
  for (let i = 1; i <= poolSize; i++) {
    pool.push(
      await createQuestion(
        QuestionType.ProblemSolving,
        { jobId: job.id },
        {
          question: `Reasoning scenario ${i}: how would you work it out?`,
          category: "logical",
          criteria: `Secret criteria PS-${i}`,
          options: ["Secret-free A", "Secret-free B", "Secret-free C", "Secret-free D"],
          correctOption: i % 4,
        }
      )
    );
  }
  const { user: talent, token } = await createCompleteTalent();
  return { recruiter, recruiterToken, config, job, pool, talent, token };
}

describe("scoring criteria never reach candidates", () => {
  it("GET /questions/:id hides criteria and category of a problem-solving question", async () => {
    const { job, pool, talent, token } = await jobWithPool();
    await createApplication(talent, job, { problemSolvingQuestions: [pool[0]!.id] });

    const res = await request(app)
      .get(`/v1/questions/${pool[0]!.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const { question } = apiData<{ question: Record<string, unknown> }>(res);
    expect(question["question"]).toBe(pool[0]!.question);
    expect(question).not.toHaveProperty("criteria");
    expect(question).not.toHaveProperty("category");
    expect(question).not.toHaveProperty("correctOption");
    expect(question["options"]).toEqual(pool[0]!.options);
    expect(JSON.stringify(res.body)).not.toContain("Secret criteria");
  });

  it("GET /questions/:id hides criteria of a culture-fit question", async () => {
    const { job, talent, token } = await jobWithPool(0);
    const cf = await createQuestion(
      QuestionType.CultureFit,
      { jobId: job.id },
      {
        criteria: "Secret criteria CF",
        category: "Ownership",
        options: ["A", "B", "C", "D"],
        correctOption: 2,
      }
    );
    await createApplication(talent, job, { cultureFitQuestions: [cf.id] });
    const res = await request(app)
      .get(`/v1/questions/${cf.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("Secret criteria");
    expect(JSON.stringify(res.body)).not.toContain("correctOption");
  });

  it("GET /questions/candidate/problem-solving sends options but never the correct one or the criteria", async () => {
    const { job, talent, token } = await jobWithPool(4);
    await createApplication(talent, job);
    const res = await loadProblemSolving(token, job.id);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("correctOption");
    expect(body).not.toContain("Secret criteria");
    const { questions } = apiData<{ questions: Array<Record<string, unknown>> }>(res);
    expect(questions).toHaveLength(3);
    for (const q of questions) {
      expect(Object.keys(q).sort()).toEqual(["id", "options", "question", "questionType"]);
    }
  });

  it("GET /questions without a questionType is refused, so the pool can't be listed", async () => {
    const { job, token } = await jobWithPool();
    const res = await request(app)
      .get("/v1/questions")
      .query({ jobId: job.id })
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).not.toContain("Secret criteria");
  });
});

const setScores = (applicationId: string) =>
  testDataSource.query(
    `UPDATE "applications" SET "problemSolvingScore" = 73, "cultureFitScore" = 41 WHERE id = $1`,
    [applicationId]
  );

const expectNoScores = (res: request.Response) => {
  expect(res.status).toBeLessThan(300);
  const body = JSON.stringify(res.body);
  expect(body).not.toContain("problemSolvingScore");
  expect(body).not.toContain("cultureFitScore");
};

describe("scores never reach candidates through other endpoints", () => {
  it("PATCH /jobs/applications/:jobId (applying again)", async () => {
    const { job, talent, token } = await jobWithPool();
    const application = await createApplication(talent, job);
    await setScores(application.id);
    const res = await request(app)
      .patch(`/v1/jobs/applications/${job.id}`)
      .set("Authorization", `Bearer ${token}`);
    expectNoScores(res);
  });

  it("GET /user/applications", async () => {
    const { job, talent, token } = await jobWithPool();
    const application = await createApplication(talent, job);
    await setScores(application.id);
    const res = await request(app)
      .get("/v1/user/applications")
      .set("Authorization", `Bearer ${token}`);
    expectNoScores(res);
    expect(JSON.stringify(res.body)).toContain(application.id);
  });

  it("POST /questions/personalized (talent, questions already generated)", async () => {
    const { job, talent, token } = await jobWithPool();
    const q = await createQuestion(QuestionType.Personalized, { jobId: job.id });
    const application = await createApplication(talent, job, { personalizedQuestions: [q.id] });
    await setScores(application.id);
    const res = await request(app)
      .post("/v1/questions/personalized")
      .set("Authorization", `Bearer ${token}`)
      .send({ jobId: job.id, talentId: talent.id });
    expectNoScores(res);
  });

  it("POST /questions/answer/personalized", async () => {
    const { job, talent, token } = await jobWithPool();
    const q = await createQuestion(QuestionType.Personalized, { jobId: job.id });
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Personalized,
      personalizedQuestions: [q.id],
    });
    await setScores(application.id);
    (AI.gradePersonalizedAnswers as jest.Mock).mockResolvedValueOnce({
      message: { content: JSON.stringify({ responses: [{ questionId: q.id, score: 0 }] }) },
    });
    const res = await request(app)
      .post("/v1/questions/answer/personalized")
      .set("Authorization", `Bearer ${token}`)
      .send({ jobId: job.id, answers: { [q.id]: "An answer." } });
    expectNoScores(res);
  });

  it("POST /questions/answer/personality", async () => {
    const { job, talent, token } = await jobWithPool();
    const q = await createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria: "EI" });
    const application = await createApplication(talent, job, { personalityQuestions: [q.id] });
    await setScores(application.id);
    (AI.evaluatePersonalityType as jest.Mock).mockResolvedValueOnce({
      message: { content: JSON.stringify({ mbtiType: "INTJ", responses: [] }) },
    });
    const res = await request(app)
      .post("/v1/questions/answer/personality")
      .set("Authorization", `Bearer ${token}`)
      .send({ jobId: job.id, answers: { [q.id]: "I recharge alone." } });
    expectNoScores(res);
  });

  it("recruiters still see the scores on GET /applications/:id", async () => {
    const { job, talent, recruiterToken } = await jobWithPool();
    const application = await createApplication(talent, job);
    await setScores(application.id);
    const res = await request(app)
      .get(`/v1/applications/${application.id}`)
      .set("Authorization", `Bearer ${recruiterToken}`);
    expect(res.status).toBe(200);
    expect(apiData<{ application: Record<string, unknown> }>(res).application).toMatchObject({
      problemSolvingScore: 73,
      cultureFitScore: 41,
    });
  });
});

const answersFor = (questions: Question[]) =>
  Object.fromEntries(questions.map((q) => [q.id, q.correctOption!]));

const submitProblemSolving = (token: string, jobId: string, questions: Question[]) =>
  request(app)
    .post("/v1/questions/answer/problem-solving")
    .set("Authorization", `Bearer ${token}`)
    .send({ jobId, answers: answersFor(questions) });

const loadProblemSolving = (token: string, jobId: string) =>
  request(app)
    .get("/v1/questions/candidate/problem-solving")
    .query({ jobId })
    .set("Authorization", `Bearer ${token}`);

const reload = (id: string) => testDataSource.getRepository(Application).findOneByOrFail({ id });

describe("a stale save from another flow can't wipe test results", () => {
  it("keeps the score when an application loaded before the submit is saved after it", async () => {
    const { job, pool, talent, token } = await jobWithPool(3);
    const application = await createApplication(talent, job, {
      problemSolvingQuestions: pool.map((q) => q.id),
    });
    const stale = await reload(application.id);

    expect((await submitProblemSolving(token, job.id, pool)).status).toBe(200);

    stale.status = ApplicationStatus.Shortlisted;
    await testDataSource.getRepository(Application).save(stale);

    const saved = await reload(application.id);
    expect(saved.status).toBe(ApplicationStatus.Shortlisted);
    expect(saved.problemSolvingScore).toBe(100);
  });

  it("keeps the assigned set when an application loaded before the first load is saved after it", async () => {
    const { job, talent, token } = await jobWithPool(6);
    const application = await createApplication(talent, job);
    const stale = await reload(application.id);

    const res = await loadProblemSolving(token, job.id);
    expect(res.status).toBe(200);
    const served = apiData<{ questions: { id: string }[] }>(res).questions.map((q) => q.id);

    stale.status = ApplicationStatus.Shortlisted;
    await testDataSource.getRepository(Application).save(stale);

    expect((await reload(application.id)).problemSolvingQuestions).toEqual(served);
  });
});

describe("a double submit is scored and saved once", () => {
  it("two parallel submits → one 200, one 409, one stored answer", async () => {
    const { job, pool, talent, token } = await jobWithPool(3);
    const application = await createApplication(talent, job, {
      problemSolvingQuestions: pool.map((q) => q.id),
    });
    const results = await Promise.all([
      submitProblemSolving(token, job.id, pool),
      submitProblemSolving(token, job.id, pool),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);

    const answers = await testDataSource.getRepository(Answer).find({
      where: { userId: talent.id, jobId: job.id, questionType: QuestionType.ProblemSolving },
    });
    expect(answers).toHaveLength(1);
    expect((await reload(application.id)).problemSolvingScore).toBe(100);
  });
});

describe("two first loads assign one question set", () => {
  it("parallel first loads return the same questions, and those are the stored set", async () => {
    const { job, talent, token } = await jobWithPool(10);
    const application = await createApplication(talent, job);

    const originalFind = Repository.prototype.find;
    const slowFind = jest.spyOn(Repository.prototype, "find").mockImplementation(async function (
      this: Repository<ObjectLiteral>,
      ...args
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return originalFind.apply(this, args);
    });
    const [a, b] = await Promise.all([
      loadProblemSolving(token, job.id),
      loadProblemSolving(token, job.id),
    ]);
    slowFind.mockRestore();
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const idsA = apiData<{ questions: { id: string }[] }>(a).questions.map((q) => q.id);
    const idsB = apiData<{ questions: { id: string }[] }>(b).questions.map((q) => q.id);
    expect(idsA).toEqual(idsB);
    expect((await reload(application.id)).problemSolvingQuestions).toEqual(idsA);
  });
});

describe("parallel generate requests respect the pool cap", () => {
  it("two parallel requests on a pool of 28 leave at most 30 questions, none repeated", async () => {
    const { job, recruiterToken } = await jobWithPool(28);
    (AI.generateProblemSolvingQuestions as jest.Mock).mockImplementation(
      async ({ count }: { count: number }) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const questions = Array.from({ length: count }, (_, i) => ({
          question: `A brand new reasoning puzzle number ${i + 1}?`,
          category: "logical",
          criteria: "Shows clear steps.",
          options: ["One", "Two", "Three", "Four"],
          correctOption: 1,
        }));
        return { message: { content: JSON.stringify({ questions }) } };
      }
    );

    const results = await Promise.all(
      [1, 2].map(() =>
        request(app)
          .post("/v1/questions/problem-solving")
          .set("Authorization", `Bearer ${recruiterToken}`)
          .send({ jobId: job.id, count: 10 })
      )
    );
    results.forEach((r) => expect(r.status).toBeLessThan(500));

    const stored = await testDataSource
      .getRepository(QuestionEntity)
      .find({ where: { jobId: job.id, type: QuestionType.ProblemSolving } });
    expect(stored.length).toBeLessThanOrEqual(30);
    expect(new Set(stored.map((q) => q.question)).size).toBe(stored.length);
  });
});

describe("questions already given to candidates can't be deleted", () => {
  const remove = (token: string, id: string) =>
    request(app).delete(`/v1/questions/${id}`).set("Authorization", `Bearer ${token}`);

  it("deleting an assigned problem-solving question → 400 and it stays", async () => {
    const { job, pool, talent, recruiterToken } = await jobWithPool(3);
    await createApplication(talent, job, { problemSolvingQuestions: pool.map((q) => q.id) });
    const res = await remove(recruiterToken, pool[1]!.id);
    expect(res.status).toBe(400);
    expect(
      await testDataSource.getRepository(QuestionEntity).findOneBy({ id: pool[1]!.id })
    ).not.toBeNull();
  });

  it("deleting an assigned culture-fit question → 400", async () => {
    const { job, talent, recruiterToken } = await jobWithPool(0);
    const cf = await createQuestion(QuestionType.CultureFit, { jobId: job.id });
    await createApplication(talent, job, { cultureFitQuestions: [cf.id] });
    expect((await remove(recruiterToken, cf.id)).status).toBe(400);
  });

  it("deleting a question nobody was given still works", async () => {
    const { job, pool, talent, recruiterToken } = await jobWithPool(3);
    await createApplication(talent, job, { problemSolvingQuestions: [pool[0]!.id] });
    expect((await remove(recruiterToken, pool[2]!.id)).status).toBe(200);
    expect(
      await testDataSource.getRepository(QuestionEntity).findOneBy({ id: pool[2]!.id })
    ).toBeNull();
  });
});
