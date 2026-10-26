/**
 * Serving problem-solving and culture-fit questions to candidates (plan Day 4).
 * Each applicant gets a random set of the recruiter's chosen size from the
 * job's pool, the same set every time they come back, and never the scoring
 * criteria.
 */
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
import type { AIConfig } from "../src/entities/AIConfig.js";
import { QuestionType } from "../src/types/enums.js";
import { AddAssessmentQuestionsToApplications1789001000000 } from "../src/migrations/1789001000000-AddAssessmentQuestionsToApplications.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
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

type ServedQuestion = Record<string, unknown> & { id: string; question: string };

const PATHS = {
  [QuestionType.ProblemSolving]: "/v1/questions/candidate/problem-solving",
  [QuestionType.CultureFit]: "/v1/questions/candidate/culture-fit",
} as const;

/** A job with the given switches, a pool of `poolSize` questions per type, and an applicant. */
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
    await createQuestion(QuestionType.ProblemSolving, { jobId: job.id }, {
      question: `Reasoning scenario ${i}: how would you work it out?`,
      category: "logical",
      criteria: `Secret criteria PS-${i}`,
    });
    await createQuestion(QuestionType.CultureFit, { jobId: job.id }, {
      question: `Tell us about a time you showed ownership (${i}).`,
      category: "Ownership",
      criteria: `Secret criteria CF-${i}`,
    });
  }
  const { user: talent, token } = await createCompleteTalent();
  const application = apply ? await createApplication(talent, job) : null;
  return { recruiter, recruiterToken, job, talent, token, application };
}

const getServed = (token: string, type: keyof typeof PATHS, jobId: string) =>
  request(app).get(PATHS[type]).query({ jobId }).set("Authorization", `Bearer ${token}`);

const servedOf = (res: request.Response): ServedQuestion[] => res.body.data.questions;

describe.each([
  [QuestionType.ProblemSolving, "problemSolvingQuestions", 3],
  [QuestionType.CultureFit, "cultureFitQuestions", 2],
] as const)("GET candidate %s questions", (type, column, configured) => {
  it(`gives the applicant ${configured} questions from the pool, without the criteria`, async () => {
    const { job, token } = await jobWithApplicant();
    const res = await getServed(token, type, job.id);
    expect(res.status).toBe(200);
    const served = servedOf(res);
    expect(served).toHaveLength(configured);
    for (const q of served) {
      expect(q.id).toEqual(expect.any(String));
      expect(q.question).toEqual(expect.any(String));
      expect(q).not.toHaveProperty("criteria");
      expect(JSON.stringify(q)).not.toContain("Secret criteria");
    }
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

  it("no questions generated yet → 409 with a plain message", async () => {
    const { job, token } = await jobWithApplicant({}, 0);
    const res = await getServed(token, type, job.id);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/isn't ready yet/i);
  });

  it("the test is switched off for this job → 400", async () => {
    const { job, token } = await jobWithApplicant({
      problemSolvingAssessment: false,
      cultureFitAssessment: false,
    });
    const res = await getServed(token, type, job.id);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not switched on/i);
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
