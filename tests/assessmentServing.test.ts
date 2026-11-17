import request from "supertest";
import type { QueryRunner } from "typeorm";
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
import { Question } from "../src/entities/Question.js";
import type { AIConfig } from "../src/entities/AIConfig.js";
import { QuestionType } from "../src/types/enums.js";
import { apiData } from "./helpers/http.js";
import * as AI from "../src/utils/integrations/openai.js";
import { AddAssessmentQuestionsToApplications1789001000000 } from "../src/migrations/1789001000000-AddAssessmentQuestionsToApplications.js";

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
  generateCultureFitQuestions: jest.fn(),
}));

const mockGenerate = {
  [QuestionType.ProblemSolving]: AI.generateProblemSolvingQuestions as jest.Mock,
  [QuestionType.CultureFit]: AI.generateCultureFitQuestions as jest.Mock,
};

const generatedReply = (count: number, prefix = "Generated puzzle") => ({
  message: {
    content: JSON.stringify({
      questions: Array.from({ length: count }, (_, i) => ({
        question: `${prefix} number ${i + 1}: which option fits?`,
        category: "logical",
        criteria: "Option one is right.",
        options: ["One", "Two", "Three", "Four"],
        correctOption: 0,
      })),
    }),
  },
});

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

type ServedQuestion = Record<string, unknown> & { id: string; question: string };

const PATHS = {
  [QuestionType.ProblemSolving]: "/v1/questions/candidate/problem-solving",
  [QuestionType.CultureFit]: "/v1/questions/candidate/culture-fit",
} as const;

async function jobWithApplicant(
  configOverrides: Partial<AIConfig> = {},
  poolSize = 6,
  apply = true
) {
  const { user: recruiter, token: recruiterToken } = await createRecruiter();
  const config = await createAIConfig(recruiter, {
    problemSolvingAssessment: true,
    noOfProblemSolvingQuestions: 3,
    cultureFitAssessment: true,
    noOfCultureFitQuestions: 2,
    ...configOverrides,
  });
  const job = await createJob(recruiter, await createRole(), { aiConfigId: config.id });
  for (let i = 1; i <= poolSize; i++) {
    await createQuestion(
      QuestionType.ProblemSolving,
      { jobId: job.id },
      {
        question: `Reasoning scenario ${i}: how would you work it out?`,
        category: "logical",
        criteria: `Secret criteria PS-${i}`,
        options: ["A", "B", "C", "D"],
        correctOption: i % 4,
      }
    );
    await createQuestion(
      QuestionType.CultureFit,
      { jobId: job.id },
      {
        question: `What would you do to show ownership here (${i})?`,
        category: "Ownership",
        criteria: `Secret criteria CF-${i}`,
        options: ["A", "B", "C", "D"],
        correctOption: i % 4,
      }
    );
  }
  const { user: talent, token } = await createCompleteTalent();
  const application = apply ? await createApplication(talent, job) : null;
  return { recruiter, recruiterToken, job, talent, token, application };
}

const getServed = (token: string, type: keyof typeof PATHS, jobId: string) =>
  request(app).get(PATHS[type]).query({ jobId }).set("Authorization", `Bearer ${token}`);

const servedOf = (res: request.Response): ServedQuestion[] =>
  apiData<{ questions: ServedQuestion[] }>(res).questions;
const errorMessage = (res: request.Response): string =>
  (res.body as { error: { message: string } }).error.message;

describe.each([
  [QuestionType.ProblemSolving, "problemSolvingQuestions", 3],
  [QuestionType.CultureFit, "cultureFitQuestions", 2],
] as const)("GET candidate %s questions", (type, column, configured) => {
  it(`gives the applicant ${configured} questions with their options, without the criteria or correct option`, async () => {
    const { job, token } = await jobWithApplicant();
    const res = await getServed(token, type, job.id);
    expect(res.status).toBe(200);
    const served = servedOf(res);
    expect(served).toHaveLength(configured);
    for (const q of served) {
      expect(Object.keys(q).sort()).toEqual(["id", "options", "question", "questionType"]);
      expect(q["options"]).toEqual(["A", "B", "C", "D"]);
    }
    expect(JSON.stringify(res.body)).not.toContain("Secret criteria");
    expect(JSON.stringify(res.body)).not.toContain("correctOption");
  });

  it("stores the set on the application and returns the same set next time", async () => {
    const { job, token, application } = await jobWithApplicant();
    const first = servedOf(await getServed(token, type, job.id)).map((q) => q.id);
    const second = servedOf(await getServed(token, type, job.id)).map((q) => q.id);
    expect(second.sort()).toEqual([...first].sort());
    const saved = await testDataSource
      .getRepository(Application)
      .findOneByOrFail({ id: application!.id });
    expect([...(saved[column] ?? [])].sort()).toEqual([...first].sort());
  });

  it("serves every question when the pool is smaller than the count", async () => {
    const { job, token } = await jobWithApplicant({}, 1);
    const res = await getServed(token, type, job.id);
    expect(res.status).toBe(200);
    expect(servedOf(res)).toHaveLength(1);
  });

  it("an empty pool is generated on the first load, then served", async () => {
    const { job, token } = await jobWithApplicant({}, 0);
    mockGenerate[type].mockResolvedValueOnce(generatedReply(5));
    const res = await getServed(token, type, job.id);
    expect(res.status).toBe(200);
    expect(servedOf(res)).toHaveLength(configured);
    expect(mockGenerate[type]).toHaveBeenCalledTimes(1);
    const pool = await testDataSource
      .getRepository(Question)
      .find({ where: { jobId: job.id, type } });
    expect(pool).toHaveLength(5);
    expect(pool.every((q) => q.options?.length === 4 && q.correctOption !== null)).toBe(true);
  });

  it("an empty pool the AI can't fill → 409 with a plain message, and a later load can retry", async () => {
    const { job, token } = await jobWithApplicant({}, 0);
    mockGenerate[type].mockRejectedValueOnce(new Error("timeout"));
    const res = await getServed(token, type, job.id);
    expect(res.status).toBe(409);
    expect(errorMessage(res)).toMatch(/isn't ready yet/i);

    mockGenerate[type].mockResolvedValueOnce(generatedReply(5));
    expect((await getServed(token, type, job.id)).status).toBe(200);
  });

  it("the test is switched off for this job → 400", async () => {
    const { job, token } = await jobWithApplicant({
      problemSolvingAssessment: false,
      cultureFitAssessment: false,
    });
    const res = await getServed(token, type, job.id);
    expect(res.status).toBe(400);
    expect(errorMessage(res)).toMatch(/not switched on/i);
  });

  it("a candidate who hasn't applied → 400", async () => {
    const { job, token } = await jobWithApplicant({}, 6, false);
    const res = await getServed(token, type, job.id);
    expect(res.status).toBe(400);
  });

  it("a recruiter can't use the candidate route → 403", async () => {
    const { job, recruiterToken } = await jobWithApplicant();
    const res = await getServed(recruiterToken, type, job.id);
    expect(res.status).toBe(403);
  });

  it("unknown job → 404, bad jobId → 400", async () => {
    const { token } = await jobWithApplicant();
    expect((await getServed(token, type, "8b1d3c3e-1b7a-4a59-9a5c-1f0f8f0e2a11")).status).toBe(404);
    expect((await getServed(token, type, "not-a-uuid")).status).toBe(400);
  });
});

it("one applicant's set doesn't change another's", async () => {
  const { job, token } = await jobWithApplicant({}, 6);
  const { user: other, token: otherToken } = await createCompleteTalent();
  await createApplication(other, job);
  const mine = servedOf(await getServed(token, QuestionType.ProblemSolving, job.id));
  const theirs = servedOf(await getServed(otherToken, QuestionType.ProblemSolving, job.id));
  expect(mine).toHaveLength(3);
  expect(theirs).toHaveLength(3);
  const again = servedOf(await getServed(token, QuestionType.ProblemSolving, job.id));
  expect(again.map((q) => q.id).sort()).toEqual(mine.map((q) => q.id).sort());
});

it.each([QuestionType.ProblemSolving, QuestionType.CultureFit] as const)(
  "gives every parallel first load of %s questions the same set",
  async (type) => {
    const { job, token, application } = await jobWithApplicant({}, 6);

    const loads = await Promise.all(
      Array.from({ length: 5 }, () => getServed(token, type, job.id))
    );

    const sets = loads.map((res) => {
      expect(res.status).toBe(200);
      return servedOf(res).map((q) => q.id);
    });
    const stored = await testDataSource
      .getRepository(Application)
      .findOneByOrFail({ id: application!.id });
    const column =
      type === QuestionType.ProblemSolving
        ? stored.problemSolvingQuestions
        : stored.cultureFitQuestions;
    for (const set of sets) expect(set).toEqual(column);
  }
);

describe("old open-ended questions", () => {
  const makeLegacy = (jobId: string, i: number) =>
    createQuestion(
      QuestionType.ProblemSolving,
      { jobId },
      { question: `Old open question ${i}: explain how you would approach it.` }
    );

  it("are never served; a pool with only old questions is filled with new ones", async () => {
    const { job, token } = await jobWithApplicant({}, 0);
    for (let i = 1; i <= 4; i++) await makeLegacy(job.id, i);
    mockGenerate[QuestionType.ProblemSolving].mockResolvedValueOnce(generatedReply(5));

    const res = await getServed(token, QuestionType.ProblemSolving, job.id);

    expect(res.status).toBe(200);
    for (const q of servedOf(res)) {
      expect(q.question).toMatch(/^Generated puzzle/);
      expect((q["options"] as string[]).length).toBe(4);
    }
  });

  it("don't count towards the pool cap", async () => {
    const { job, recruiterToken } = await jobWithApplicant({}, 0);
    for (let i = 1; i <= 30; i++) await makeLegacy(job.id, i);
    mockGenerate[QuestionType.ProblemSolving].mockResolvedValueOnce(generatedReply(5));

    const res = await request(app)
      .post("/v1/questions/problem-solving")
      .set("Authorization", `Bearer ${recruiterToken}`)
      .send({ jobId: job.id, count: 5 });

    expect(res.status).toBeLessThan(300);
  });

  it("an unsubmitted set holding an old question is replaced by a new set", async () => {
    const { job, token, application } = await jobWithApplicant();
    const legacy = await makeLegacy(job.id, 1);
    await testDataSource.query(
      `UPDATE "applications" SET "problemSolvingQuestions" = $1 WHERE id = $2`,
      [legacy.id, application!.id]
    );

    const res = await getServed(token, QuestionType.ProblemSolving, job.id);

    expect(res.status).toBe(200);
    const ids = servedOf(res).map((q) => q.id);
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain(legacy.id);
    const saved = await testDataSource
      .getRepository(Application)
      .findOneByOrFail({ id: application!.id });
    expect(saved.problemSolvingQuestions).toEqual(ids);
  });

  it("a set already scored is kept as it was", async () => {
    const { job, token, application } = await jobWithApplicant();
    const legacy = await makeLegacy(job.id, 1);
    await testDataSource.query(
      `UPDATE "applications" SET "problemSolvingQuestions" = $1, "problemSolvingScore" = 60 WHERE id = $2`,
      [legacy.id, application!.id]
    );

    const res = await getServed(token, QuestionType.ProblemSolving, job.id);

    expect(servedOf(res).map((q) => q.id)).toEqual([legacy.id]);
    expect(servedOf(res)[0]!["options"]).toEqual([]);
  });

  it("parallel first loads on an empty pool ask the AI once and share one set", async () => {
    const { job, token, application } = await jobWithApplicant({}, 0);
    mockGenerate[QuestionType.ProblemSolving].mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return generatedReply(5);
    });

    const responses = await Promise.all(
      Array.from({ length: 4 }, () => getServed(token, QuestionType.ProblemSolving, job.id))
    );

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(mockGenerate[QuestionType.ProblemSolving]).toHaveBeenCalledTimes(1);
    const saved = await testDataSource
      .getRepository(Application)
      .findOneByOrFail({ id: application!.id });
    for (const res of responses) {
      expect(servedOf(res).map((q) => q.id)).toEqual(saved.problemSolvingQuestions);
    }
  });
});

describe("AddAssessmentQuestionsToApplications migration", () => {
  it("adds the two question-set columns and removes them on down", async () => {
    const queries: string[] = [];
    const runner = {
      query: (sql: string) => Promise.resolve(void queries.push(sql)),
    } as unknown as QueryRunner;
    await new AddAssessmentQuestionsToApplications1789001000000().up(runner);
    expect(queries).toEqual([
      `ALTER TABLE "applications" ADD "problemSolvingQuestions" text`,
      `ALTER TABLE "applications" ADD "cultureFitQuestions" text`,
    ]);
    queries.length = 0;
    await new AddAssessmentQuestionsToApplications1789001000000().down(runner);
    expect(queries).toEqual([
      `ALTER TABLE "applications" DROP COLUMN "cultureFitQuestions"`,
      `ALTER TABLE "applications" DROP COLUMN "problemSolvingQuestions"`,
    ]);
  });
});

describe("serving under concurrency and recovery", () => {
  it("two overlapping first loads give the applicant one set", async () => {
    const { token, job, application } = await jobWithApplicant();

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => getServed(token, QuestionType.ProblemSolving, job.id))
    );

    expect(responses.map((r) => r.status)).toEqual(Array(6).fill(200));
    const ids = (res: request.Response) => servedOf(res).map((q) => q.id);
    const [a] = responses as [request.Response];
    for (const res of responses) expect(ids(res)).toEqual(ids(a));
    const saved = await testDataSource
      .getRepository(Application)
      .findOneByOrFail({ id: application!.id });
    expect(saved.problemSolvingQuestions).toEqual(ids(a));
  });

  it("serves a full new set when one of the applicant's questions was deleted", async () => {
    const { token, job, application } = await jobWithApplicant();
    const first = servedOf(await getServed(token, QuestionType.ProblemSolving, job.id));
    await testDataSource.getRepository(Question).delete({ id: first[0]!.id });

    const res = await getServed(token, QuestionType.ProblemSolving, job.id);

    expect(res.status).toBe(200);
    expect(servedOf(res)).toHaveLength(3);
    const saved = await testDataSource
      .getRepository(Application)
      .findOneByOrFail({ id: application!.id });
    expect(saved.problemSolvingQuestions).toEqual(servedOf(res).map((q) => q.id));
    expect(saved.problemSolvingQuestions).not.toContain(first[0]!.id);
  });

  it("keeps the set once the applicant has been scored, even if a question was deleted", async () => {
    const { token, job, application } = await jobWithApplicant();
    const first = servedOf(await getServed(token, QuestionType.ProblemSolving, job.id));
    await testDataSource.query(
      `UPDATE "applications" SET "problemSolvingScore" = 60 WHERE id = $1`,
      [application!.id]
    );
    await testDataSource.getRepository(Question).delete({ id: first[0]!.id });

    const res = await getServed(token, QuestionType.ProblemSolving, job.id);

    expect(servedOf(res)).toHaveLength(2);
  });

  it("a jobId sent as a list → 400", async () => {
    const { token, job } = await jobWithApplicant();

    const res = await request(app)
      .get(`${PATHS[QuestionType.ProblemSolving]}?jobId[]=${job.id}&jobId[]=${job.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
  });
});
