/**
 * Day 6–7 (plan feature 3): personality fit score. Right after the MBTI type is
 * saved, the AI judges how well that personality fits the job and gives a
 * 0-100 score with a short reason. No formula of ours; skipped when the job's
 * personality check is off. Only the job's company sees it.
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
  createTalent,
  createRecruiter,
  createRole,
  createJob,
  createAIConfig,
  createApplication,
  createQuestion,
} from "./helpers/fixtures.js";
import { Application } from "../src/entities/Application.js";
import { Job } from "../src/entities/Job.js";
import { QuestionType, ScreeningStage } from "../src/types/enums.js";
import * as AI from "../src/utils/integrations/openai.js";
import { AddPersonalityFitToApplications1789001200000 } from "../src/migrations/1789001200000-AddPersonalityFitToApplications.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
  evaluatePersonalityType: jest.fn(),
  evaluatePersonalityFit: jest.fn(),
}));

const mockType = AI.evaluatePersonalityType as jest.Mock;
const mockFit = AI.evaluatePersonalityFit as jest.Mock;

const aiReply = (content: unknown) => ({
  message: { content: typeof content === "string" ? content : JSON.stringify(content) },
});

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

beforeEach(() => {
  mockType.mockResolvedValue(aiReply({ mbtiType: "INTJ", responses: [] }));
  mockFit.mockResolvedValue(
    aiReply({ personalityFitScore: 78, personalityFitReason: "Plans ahead, suits the role." })
  );
});

afterEach(async () => {
  await clearAllTables();
  jest.resetAllMocks();
});

async function setup(personalityEvaluation = true) {
  const { user: recruiter, token: recruiterToken } = await createRecruiter();
  const role = await createRole();
  const job = await createJob(recruiter, role);
  const aiConfig = await createAIConfig(recruiter, {
    personalityEvaluation,
    stages: { personality: "completed" },
  });
  await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });
  const { user: talent, token: talentToken } = await createTalent({ prescreeningScore: 75 });
  const application = await createApplication(talent, job, {
    stages: { personality: "completed" },
    currentStage: ScreeningStage.Personality,
  });
  const questions = await Promise.all(
    ["EI", "SN", "TF", "JP"].map((criteria) =>
      createQuestion(QuestionType.Personality, { jobId: job.id }, { criteria })
    )
  );
  const answers = Object.fromEntries(questions.map((q) => [q!.id, "An honest answer"]));
  const submit = () =>
    request(app)
      .post("/v1/questions/answer/personality")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({ jobId: job.id, answers });
  const reload = () =>
    testDataSource.getRepository(Application).findOneByOrFail({ id: application.id });
  return { job, application, submit, reload, recruiterToken, talentToken };
}

describe("Day 6 — personality fit score after the MBTI type is saved", () => {
  it("asks the AI to judge the saved MBTI type against the job and stores its score and reason", async () => {
    const { job, submit, reload } = await setup();

    const res = await submit();

    expect(res.status).toBe(200);
    expect(mockFit).toHaveBeenCalledTimes(1);
    const context = mockFit.mock.calls[0][0];
    expect(context.mbtiType).toBe("INTJ");
    expect(context.job.jobBrief).toBe(job.jobBrief);
    const saved = await reload();
    expect(saved.mbtiType).toBe("INTJ");
    expect(saved.personalityFitScore).toBe(78);
    expect(saved.personalityFitReason).toBe("Plans ahead, suits the role.");
  });

  it("is skipped when the job's personality check is off", async () => {
    const { submit, reload } = await setup(false);

    const res = await submit();

    expect(res.status).toBe(400);
    expect(mockFit).not.toHaveBeenCalled();
    const saved = await reload();
    expect(saved.personalityFitScore).toBeNull();
    expect(saved.personalityFitReason).toBeNull();
  });

  it("keeps the MBTI result when the fit call fails, and leaves the fit empty", async () => {
    mockFit.mockRejectedValue(new Error("AI down"));
    const { submit, reload } = await setup();

    const res = await submit();

    expect(res.status).toBe(200);
    const saved = await reload();
    expect(saved.mbtiType).toBe("INTJ");
    expect(saved.personalityFitScore).toBeNull();
    expect(saved.personalityFitReason).toBeNull();
  });

  it.each([
    ["a score above 100", { personalityFitScore: 140, personalityFitReason: "x" }],
    ["a negative score", { personalityFitScore: -5, personalityFitReason: "x" }],
    ["a score that isn't a number", { personalityFitScore: "high", personalityFitReason: "x" }],
    ["no reason", { personalityFitScore: 60 }],
    ["text that isn't JSON", "not json"],
  ])("ignores an AI reply with %s", async (_label, content) => {
    mockFit.mockResolvedValue(aiReply(content));
    const { submit, reload } = await setup();

    expect((await submit()).status).toBe(200);
    const saved = await reload();
    expect(saved.mbtiType).toBe("INTJ");
    expect(saved.personalityFitScore).toBeNull();
    expect(saved.personalityFitReason).toBeNull();
  });

  it("shows the fit to the job's company but not to the candidate", async () => {
    const { application, submit, recruiterToken, talentToken } = await setup();
    await submit();

    const asCompany = await request(app)
      .get(`/v1/applications/${application.id}`)
      .set("Authorization", `Bearer ${recruiterToken}`);
    expect(asCompany.status).toBe(200);
    expect(asCompany.body.data.application.personalityFitScore).toBe(78);
    expect(asCompany.body.data.application.personalityFitReason).toBe(
      "Plans ahead, suits the role."
    );

    const asCandidate = await request(app)
      .get(`/v1/applications/${application.id}`)
      .set("Authorization", `Bearer ${talentToken}`);
    expect(asCandidate.status).toBe(200);
    expect(asCandidate.body.data.application).not.toHaveProperty("personalityFitScore");
    expect(asCandidate.body.data.application).not.toHaveProperty("personalityFitReason");
  });
});

describe("AddPersonalityFitToApplications migration", () => {
  it("adds the two nullable columns and removes them on down", async () => {
    const queries: string[] = [];
    const runner = {
      query: (sql: string) => Promise.resolve(void queries.push(sql)),
    } as unknown as QueryRunner;
    await new AddPersonalityFitToApplications1789001200000().up(runner);
    expect(queries).toEqual([
      `ALTER TABLE "applications" ADD "personalityFitScore" double precision`,
      `ALTER TABLE "applications" ADD "personalityFitReason" text`,
    ]);
    queries.length = 0;
    await new AddPersonalityFitToApplications1789001200000().down(runner);
    expect(queries).toEqual([
      `ALTER TABLE "applications" DROP COLUMN "personalityFitReason"`,
      `ALTER TABLE "applications" DROP COLUMN "personalityFitScore"`,
    ]);
  });
});
