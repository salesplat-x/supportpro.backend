import request from "supertest";
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
import { Application } from "../src/entities/Application.js";
import type { Job } from "../src/entities/Job.js";
import type { Question } from "../src/entities/Question.js";
import { ApplicationStatus, QuestionType, ScreeningStage } from "../src/types/enums.js";
import * as AI from "../src/utils/integrations/openai.js";
import { createStages } from "../src/services/aiConfig.js";
import { AddAssessmentScreeningStages1789004400000 } from "../src/migrations/1789004400000-AddAssessmentScreeningStages.js";
import type { QueryRunner } from "typeorm";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
  gradePersonalizedAnswers: jest.fn(),
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

const SWITCHES = {
  prescreeningAssessment: true,
  cvSimilarity: false,
  personalizedAssessment: true,
  noPersonalizedQuestions: 1,
  problemSolvingAssessment: true,
  noOfProblemSolvingQuestions: 2,
  cultureFitAssessment: true,
  noOfCultureFitQuestions: 2,
  personalityEvaluation: false,
};

const choice = (type: QuestionType, jobId: string, i: number) =>
  createQuestion(
    type,
    { jobId },
    {
      question: `${type} question ${i}: which would you pick?`,
      options: ["A", "B", "C", "D"],
      correctOption: 1,
    }
  );

async function pipeline(stage: ScreeningStage, overrides: Partial<Application> = {}) {
  const { user: recruiter } = await createRecruiter();
  const { stages } = createStages(SWITCHES);
  const config = await createAIConfig(recruiter, { ...SWITCHES, stages });
  const job = await createJob(recruiter, await createRole(), { aiConfigId: config.id });
  const ps = [
    await choice(QuestionType.ProblemSolving, job.id, 1),
    await choice(QuestionType.ProblemSolving, job.id, 2),
  ];
  const cf = [
    await choice(QuestionType.CultureFit, job.id, 1),
    await choice(QuestionType.CultureFit, job.id, 2),
  ];
  const { user: talent, token } = await createCompleteTalent();
  const application = await createApplication(talent, job, {
    stages,
    currentStage: stage,
    ...overrides,
  });
  return { job, talent, token, application, ps, cf };
}

const load = (token: string, path: string, job: Job) =>
  request(app)
    .get(`/v1/questions/candidate/${path}`)
    .query({ jobId: job.id })
    .set("Authorization", `Bearer ${token}`);

const assign = (applicationId: string, column: string, questions: Question[]) =>
  testDataSource.query(`UPDATE "applications" SET "${column}" = $1 WHERE id = $2`, [
    questions.map((q) => q.id).join(","),
    applicationId,
  ]);

const submit = (token: string, path: string, job: Job, questions: Question[]) =>
  request(app)
    .post(`/v1/questions/answer/${path}`)
    .set("Authorization", `Bearer ${token}`)
    .send({ jobId: job.id, answers: Object.fromEntries(questions.map((q) => [q.id, 1])) });

const reload = (id: string) => testDataSource.getRepository(Application).findOneByOrFail({ id });

describe("problem-solving and culture-fit as screening stages", () => {
  it("new pipelines run skills test, CV, tailored, problem-solving, culture-fit, personality, interview", () => {
    const { stages, entryStage } = createStages({
      ...SWITCHES,
      cvSimilarity: true,
      personalityEvaluation: true,
      aiInterview: true,
    });
    expect(entryStage).toBe(ScreeningStage.Prescreening);
    expect(stages).toEqual({
      prescreening: "cv_similarity",
      cv_similarity: "personalized",
      personalized: "problem_solving",
      problem_solving: "culture_fit",
      culture_fit: "personality",
      personality: "ai_interview",
      ai_interview: "completed",
    });
  });

  it("a test that isn't open yet can't be loaded or submitted → 400", async () => {
    const { job, token, application, ps } = await pipeline(ScreeningStage.Personalized);

    const loaded = await load(token, "problem-solving", job);
    expect(loaded.status).toBe(400);
    expect((loaded.body as { error: { message: string } }).error.message).toMatch(
      /isn't open yet/i
    );

    await assign(application.id, "problemSolvingQuestions", ps);
    expect((await submit(token, "problem-solving", job, ps)).status).toBe(400);
    expect((await reload(application.id)).problemSolvingScore).toBeNull();
  });

  it("an application made before the tests were stages can still take them", async () => {
    const { job, token, application, ps } = await pipeline(ScreeningStage.Personalized, {
      stages: { prescreening: "personalized", personalized: "completed" },
    });
    expect((await load(token, "problem-solving", job)).status).toBe(200);
    const assigned = (await reload(application.id)).problemSolvingQuestions!;
    const res = await submit(
      token,
      "problem-solving",
      job,
      ps.filter((q) => assigned.includes(q.id))
    );
    expect(res.status).toBe(200);
    expect((await reload(application.id)).currentStage).toBe(ScreeningStage.Personalized);
  });

  it("submitting problem-solving opens culture-fit, and culture-fit completes the pipeline", async () => {
    const { job, token, application, ps, cf } = await pipeline(ScreeningStage.ProblemSolving);

    await assign(application.id, "problemSolvingQuestions", ps);
    expect((await submit(token, "problem-solving", job, ps)).status).toBe(200);
    let saved = await reload(application.id);
    expect(saved.currentStage).toBe(ScreeningStage.CultureFit);
    expect(saved.status).toBe(ApplicationStatus.Pending);

    expect((await load(token, "culture-fit", job)).status).toBe(200);
    await assign(application.id, "cultureFitQuestions", cf);
    expect((await submit(token, "culture-fit", job, cf)).status).toBe(200);
    saved = await reload(application.id);
    expect(saved.currentStage).toBe(ScreeningStage.Completed);
    expect(saved.status).toBe(ApplicationStatus.AwaitingDecision);
    expect(saved.problemSolvingScore).toBe(100);
    expect(saved.cultureFitScore).toBe(100);
  });

  it("a candidate the recruiter already rejected keeps that decision after submitting", async () => {
    const { job, token, application, ps } = await pipeline(ScreeningStage.ProblemSolving, {
      status: ApplicationStatus.Rejected,
    });
    await assign(application.id, "problemSolvingQuestions", ps);

    expect((await submit(token, "problem-solving", job, ps)).status).toBe(200);

    const saved = await reload(application.id);
    expect(saved.status).toBe(ApplicationStatus.Rejected);
    expect(saved.currentStage).toBe(ScreeningStage.ProblemSolving);
    expect(saved.problemSolvingScore).toBe(100);
  });

  it("two quick problem-solving submits move the stage once", async () => {
    const { job, token, application, ps } = await pipeline(ScreeningStage.ProblemSolving);
    await assign(application.id, "problemSolvingQuestions", ps);

    const statuses = (
      await Promise.all([
        submit(token, "problem-solving", job, ps),
        submit(token, "problem-solving", job, ps),
      ])
    )
      .map((r) => r.status)
      .sort();

    expect(statuses).toEqual([200, 409]);
    expect((await reload(application.id)).currentStage).toBe(ScreeningStage.CultureFit);
  });
});

describe("tailored questions submit", () => {
  const graded = (questionId: string, score: number) => ({
    message: {
      content: JSON.stringify({ responses: [{ questionId, answer: "My answer", score }] }),
    },
  });

  it("doesn't undo a recruiter's decision made while the answers were being graded", async () => {
    const { job, token, application } = await pipeline(ScreeningStage.Personalized);
    const tailored = await createQuestion(QuestionType.Personalized, { jobId: job.id });
    (AI.gradePersonalizedAnswers as jest.Mock).mockImplementationOnce(async () => {
      await testDataSource.query(`UPDATE "applications" SET "status" = $1 WHERE id = $2`, [
        ApplicationStatus.Shortlisted,
        application.id,
      ]);
      return graded(tailored.id, 5);
    });

    const res = await request(app)
      .post("/v1/questions/answer/personalized")
      .set("Authorization", `Bearer ${token}`)
      .send({ jobId: job.id, answers: { [tailored.id]: "My answer" } });

    expect(res.status).toBe(200);
    const saved = await reload(application.id);
    expect(saved.status).toBe(ApplicationStatus.Shortlisted);
    expect(saved.personalizedScore).toBe(100);
  });

  it("a passing answer moves the candidate on to problem-solving", async () => {
    const { job, token, application } = await pipeline(ScreeningStage.Personalized);
    const tailored = await createQuestion(QuestionType.Personalized, { jobId: job.id });
    (AI.gradePersonalizedAnswers as jest.Mock).mockResolvedValueOnce(graded(tailored.id, 5));

    const res = await request(app)
      .post("/v1/questions/answer/personalized")
      .set("Authorization", `Bearer ${token}`)
      .send({ jobId: job.id, answers: { [tailored.id]: "My answer" } });

    expect(res.status).toBe(200);
    expect((await reload(application.id)).currentStage).toBe(ScreeningStage.ProblemSolving);
  });
});

describe("when each stage was reached", () => {
  it("is stamped on insert and on every move, and the first time a stage was reached is kept", async () => {
    const { application } = await pipeline(ScreeningStage.Prescreening);
    const first = await reload(application.id);
    expect(Object.keys(first.stageReachedAt)).toEqual([ScreeningStage.Prescreening]);
    const reachedAt = first.stageReachedAt[ScreeningStage.Prescreening];

    await testDataSource
      .getRepository(Application)
      .update(application.id, { currentStage: ScreeningStage.Personalized });
    await testDataSource
      .getRepository(Application)
      .update(application.id, { currentStage: ScreeningStage.Prescreening });

    const saved = await reload(application.id);
    expect(Object.keys(saved.stageReachedAt).sort()).toEqual(
      [ScreeningStage.Personalized, ScreeningStage.Prescreening].sort()
    );
    expect(saved.stageReachedAt[ScreeningStage.Prescreening]).toBe(reachedAt);
  });

  it("a stale full save can't overwrite it", async () => {
    const { application } = await pipeline(ScreeningStage.Prescreening);
    const stale = await reload(application.id);
    await testDataSource
      .getRepository(Application)
      .update(application.id, { currentStage: ScreeningStage.Personalized });

    stale.status = ApplicationStatus.Shortlisted;
    stale.stageReachedAt = {};
    await testDataSource.getRepository(Application).save(stale);

    const saved = await reload(application.id);
    expect(Object.keys(saved.stageReachedAt)).toContain(ScreeningStage.Personalized);
  });
});

describe("AddAssessmentScreeningStages migration", () => {
  it("adds the enum values, the column and the stamping trigger, and removes them on down", async () => {
    const queries: string[] = [];
    const runner = {
      query: (sql: string) => Promise.resolve(void queries.push(sql)),
    } as unknown as QueryRunner;
    await new AddAssessmentScreeningStages1789004400000().up(runner);
    expect(queries[0]).toContain(`ADD VALUE IF NOT EXISTS 'problem_solving' BEFORE 'ai_interview'`);
    expect(queries[1]).toContain(`ADD VALUE IF NOT EXISTS 'culture_fit' BEFORE 'ai_interview'`);
    expect(queries[2]).toBe(
      `ALTER TABLE "applications" ADD "stageReachedAt" jsonb NOT NULL DEFAULT '{}'`
    );
    expect(queries.join("\n")).toContain(`CREATE TRIGGER "applications_stamp_stage_reached"`);
    queries.length = 0;
    await new AddAssessmentScreeningStages1789004400000().down(runner);
    expect(queries[queries.length - 1]).toBe(
      `ALTER TABLE "applications" DROP COLUMN "stageReachedAt"`
    );
  });
});
