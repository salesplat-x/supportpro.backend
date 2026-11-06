import request from "supertest";
import type { QueryRunner } from "typeorm";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { createRecruiter, createAIConfig, createJob, createRole } from "./helpers/fixtures.js";
import { AIConfig } from "../src/entities/AIConfig.js";
import { AddAssessmentSwitchesToAIConfigs1789000900000 } from "../src/migrations/1789000900000-AddAssessmentSwitchesToAIConfigs.js";
import { MAX_ASSESSMENT_QUESTIONS_PER_CANDIDATE } from "../src/config/assessmentQuestions.js";
import { apiData } from "./helpers/http.js";

const createdId = (res: request.Response) => apiData<{ aiConfig: AIConfig }>(res).aiConfig.id;

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

const baseConfigBody = {
  name: "Day 4 config",
  minPrescreeningScore: 60,
  cvSimilarity: true,
  minCvSimilarityScore: 50,
  personalizedAssessment: true,
  noPersonalizedQuestions: 2,
  personalityEvaluation: true,
  noOfEIQuestions: 3,
};

const savedConfig = (id: string) => testDataSource.getRepository(AIConfig).findOneByOrFail({ id });

async function recruiterWithJob() {
  const { user: recruiter, token } = await createRecruiter();
  const job = await createJob(recruiter, await createRole());
  return { recruiter, token, job };
}

const createConfig = (token: string, body: Record<string, unknown>) =>
  request(app).post("/v1/ai-config/").set("Authorization", `Bearer ${token}`).send(body);

const updateConfig = (token: string, id: string, body: Record<string, unknown>) =>
  request(app).patch(`/v1/ai-config/${id}`).set("Authorization", `Bearer ${token}`).send(body);

describe("POST /v1/ai-config/ with the Day 4 switches", () => {
  it("saves both switches and their question counts", async () => {
    const { token, job } = await recruiterWithJob();
    const res = await createConfig(token, {
      ...baseConfigBody,
      jobId: job.id,
      problemSolvingAssessment: true,
      noOfProblemSolvingQuestions: 4,
      cultureFitAssessment: true,
      noOfCultureFitQuestions: 3,
    });
    expect(res.status).toBe(201);
    const config = await savedConfig(createdId(res));
    expect(config.problemSolvingAssessment).toBe(true);
    expect(config.noOfProblemSolvingQuestions).toBe(4);
    expect(config.cultureFitAssessment).toBe(true);
    expect(config.noOfCultureFitQuestions).toBe(3);
  });

  it("leaves both tests off, with no counts, when they aren't sent", async () => {
    const { token, job } = await recruiterWithJob();
    const res = await createConfig(token, { ...baseConfigBody, jobId: job.id });
    expect(res.status).toBe(201);
    const config = await savedConfig(createdId(res));
    expect(config.problemSolvingAssessment).toBe(false);
    expect(config.noOfProblemSolvingQuestions).toBeNull();
    expect(config.cultureFitAssessment).toBe(false);
    expect(config.noOfCultureFitQuestions).toBeNull();
  });

  it("does not add the new tests to the screening stages", async () => {
    const { token, job } = await recruiterWithJob();
    const withTests = await createConfig(token, {
      ...baseConfigBody,
      jobId: job.id,
      problemSolvingAssessment: true,
      noOfProblemSolvingQuestions: 2,
      cultureFitAssessment: true,
      noOfCultureFitQuestions: 2,
    });
    const config = await savedConfig(createdId(withTests));
    expect(Object.keys(config.stages ?? {}).sort()).toEqual(
      ["cv_similarity", "personality", "personalized", "prescreening"].sort()
    );
  });

  it.each([
    ["problemSolvingAssessment", "noOfProblemSolvingQuestions"],
    ["cultureFitAssessment", "noOfCultureFitQuestions"],
  ])("%s on without %s → 400", async (flag, countField) => {
    const { token, job } = await recruiterWithJob();
    const res = await createConfig(token, { ...baseConfigBody, jobId: job.id, [flag]: true });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(countField);
  });

  it.each([0, MAX_ASSESSMENT_QUESTIONS_PER_CANDIDATE + 1, 2.5, "lots"])(
    "a question count of %p → 400",
    async (count) => {
      const { token, job } = await recruiterWithJob();
      const res = await createConfig(token, {
        ...baseConfigBody,
        jobId: job.id,
        problemSolvingAssessment: true,
        noOfProblemSolvingQuestions: count,
      });
      expect(res.status).toBe(400);
    }
  );

  it("a switch that isn't true/false → 400", async () => {
    const { token, job } = await recruiterWithJob();
    const res = await createConfig(token, {
      ...baseConfigBody,
      jobId: job.id,
      cultureFitAssessment: "maybe",
      noOfCultureFitQuestions: 2,
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /v1/ai-config/:id with the Day 4 switches", () => {
  it("turns a test on with a count, then off again", async () => {
    const { recruiter, token } = await recruiterWithJob();
    const config = await createAIConfig(recruiter);

    const on = await updateConfig(token, config.id, {
      problemSolvingAssessment: true,
      noOfProblemSolvingQuestions: 5,
    });
    expect(on.status).toBe(200);
    let saved = await savedConfig(config.id);
    expect(saved.problemSolvingAssessment).toBe(true);
    expect(saved.noOfProblemSolvingQuestions).toBe(5);

    const off = await updateConfig(token, config.id, { problemSolvingAssessment: false });
    expect(off.status).toBe(200);
    saved = await savedConfig(config.id);
    expect(saved.problemSolvingAssessment).toBe(false);
  });

  it("changing only the count of a test that is already on is allowed", async () => {
    const { recruiter, token } = await recruiterWithJob();
    const config = await createAIConfig(recruiter, {
      cultureFitAssessment: true,
      noOfCultureFitQuestions: 2,
    } as Partial<AIConfig>);
    const res = await updateConfig(token, config.id, { noOfCultureFitQuestions: 6 });
    expect(res.status).toBe(200);
    expect((await savedConfig(config.id)).noOfCultureFitQuestions).toBe(6);
  });

  it("turning a test on when the config has no count for it → 400", async () => {
    const { recruiter, token } = await recruiterWithJob();
    const config = await createAIConfig(recruiter);
    const res = await updateConfig(token, config.id, { cultureFitAssessment: true });
    expect(res.status).toBe(400);
    expect((await savedConfig(config.id)).cultureFitAssessment).toBe(false);
  });

  it("turning a test on reuses a count saved earlier", async () => {
    const { recruiter, token } = await recruiterWithJob();
    const config = await createAIConfig(recruiter, {
      problemSolvingAssessment: false,
      noOfProblemSolvingQuestions: 3,
    } as Partial<AIConfig>);
    const res = await updateConfig(token, config.id, { problemSolvingAssessment: true });
    expect(res.status).toBe(200);
    expect((await savedConfig(config.id)).problemSolvingAssessment).toBe(true);
  });
});

describe("AddAssessmentSwitchesToAIConfigs migration", () => {
  it("adds two off-by-default switches and two nullable counts, and removes them on down", async () => {
    const queries: string[] = [];
    const runner = {
      query: (sql: string) => Promise.resolve(void queries.push(sql)),
    } as unknown as QueryRunner;

    await new AddAssessmentSwitchesToAIConfigs1789000900000().up(runner);
    expect(queries).toEqual([
      `ALTER TABLE "ai_configs" ADD "problemSolvingAssessment" boolean NOT NULL DEFAULT false`,
      `ALTER TABLE "ai_configs" ADD "noOfProblemSolvingQuestions" integer`,
      `ALTER TABLE "ai_configs" ADD "cultureFitAssessment" boolean NOT NULL DEFAULT false`,
      `ALTER TABLE "ai_configs" ADD "noOfCultureFitQuestions" integer`,
    ]);

    queries.length = 0;
    await new AddAssessmentSwitchesToAIConfigs1789000900000().down(runner);
    expect(queries).toEqual([
      `ALTER TABLE "ai_configs" DROP COLUMN "noOfCultureFitQuestions"`,
      `ALTER TABLE "ai_configs" DROP COLUMN "cultureFitAssessment"`,
      `ALTER TABLE "ai_configs" DROP COLUMN "noOfProblemSolvingQuestions"`,
      `ALTER TABLE "ai_configs" DROP COLUMN "problemSolvingAssessment"`,
    ]);
  });
});
