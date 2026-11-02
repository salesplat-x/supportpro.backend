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
import { Answer } from "../src/entities/Answer.js";
import { Job } from "../src/entities/Job.js";
import { AIConfig } from "../src/entities/AIConfig.js";
import { ApplicationStatus, QuestionType, ScreeningStage } from "../src/types/enums.js";
import * as AI from "../src/utils/integrations/openai.js";
import { apiData } from "./helpers/http.js";
import { AddPersonalityFitToApplications1789001200000 } from "../src/migrations/1789001200000-AddPersonalityFitToApplications.js";
import { AddPersonalityFitLockToApplications1789001250000 } from "../src/migrations/1789001250000-AddPersonalityFitLockToApplications.js";

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
  assessApplicationMatch: jest.fn(),
}));

const mockType = AI.evaluatePersonalityType as jest.Mock;
const mockMatch = AI.assessApplicationMatch as jest.Mock<
  Promise<unknown>,
  [{ mbtiType?: string | null }]
>;
const mockFit = AI.evaluatePersonalityFit as jest.Mock<
  Promise<unknown>,
  [AI.PersonalityFitContext]
>;

type SentApplication = Record<string, unknown>;
const sentApplication = (res: request.Response) =>
  apiData<{ application: SentApplication }>(res).application;

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
  await settled();
  await clearAllTables();
  jest.resetAllMocks();
});

const applications = () => testDataSource.getRepository(Application);

/** Polls until `check` passes; the fit runs after the response is sent. */
async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Waits until no background fit call holds a lock. */
const settled = () =>
  waitFor(async () => (await applications().count({ where: {} })) === 0 || !(await locked()));

const locked = async () =>
  (await applications().find()).some((a) => a.personalityFitLockedAt !== null);

/** A promise the test resolves by hand, to hold an AI call open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  return { job, application, submit, reload, recruiterToken, talentToken, talent };
}

const fitSaved = (reload: () => Promise<Application>) => () =>
  waitFor(async () => (await reload()).personalityFitScore !== null);

const fitCallFinished = () =>
  waitFor(async () => mockFit.mock.calls.length > 0 && !(await locked()));

describe("Day 6 — personality fit score after the MBTI type is saved", () => {
  it("asks the AI to judge the saved MBTI type against the job and stores its score and reason", async () => {
    const { job, submit, reload } = await setup();

    const res = await submit();

    expect(res.status).toBe(200);
    await fitSaved(reload)();
    expect(mockFit).toHaveBeenCalledTimes(1);
    const context = mockFit.mock.calls[0]![0];
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
    await fitCallFinished();
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
    await fitCallFinished();
    const saved = await reload();
    expect(saved.mbtiType).toBe("INTJ");
    expect(saved.personalityFitScore).toBeNull();
    expect(saved.personalityFitReason).toBeNull();
  });

  it("shows the fit to the job's company but not to the candidate", async () => {
    const { application, submit, reload, recruiterToken, talentToken } = await setup();
    await submit();
    await fitSaved(reload)();

    const asCompany = await request(app)
      .get(`/v1/applications/${application.id}`)
      .set("Authorization", `Bearer ${recruiterToken}`);
    expect(asCompany.status).toBe(200);
    expect(sentApplication(asCompany).personalityFitScore).toBe(78);
    expect(sentApplication(asCompany).personalityFitReason).toBe("Plans ahead, suits the role.");

    const asCandidate = await request(app)
      .get(`/v1/applications/${application.id}`)
      .set("Authorization", `Bearer ${talentToken}`);
    expect(asCandidate.status).toBe(200);
    expect(sentApplication(asCandidate)).not.toHaveProperty("personalityFitScore");
    expect(sentApplication(asCandidate)).not.toHaveProperty("personalityFitReason");
    expect(sentApplication(asCandidate)).not.toHaveProperty("personalityFitPending");
  });
});

describe("Day 6 — personality fit hardening", () => {
  it("sends the candidate no fit or company-test scores in the submit response", async () => {
    const { submit, reload, application } = await setup();
    await testDataSource.query(
      `UPDATE "applications" SET "cultureFitScore" = 64, "problemSolvingScore" = 40 WHERE id = $1`,
      [application.id]
    );

    const res = await submit();

    expect(res.status).toBe(200);
    const sent = apiData<{ application: Record<string, unknown> }>(res).application;
    expect(sent.mbtiType).toBe("INTJ");
    for (const hidden of [
      "personalityFitScore",
      "personalityFitReason",
      "personalityFitLockedAt",
      "cultureFitScore",
      "problemSolvingScore",
    ]) {
      expect(sent).not.toHaveProperty(hidden);
    }
    await fitSaved(reload)();
  });

  it("answers the candidate without waiting for the fit call", async () => {
    const hold = deferred<unknown>();
    mockFit.mockReturnValue(hold.promise);
    const { submit, reload } = await setup();

    const res = await submit();

    expect(res.status).toBe(200);
    expect((await reload()).personalityFitScore).toBeNull();
    hold.resolve(aiReply({ personalityFitScore: 61, personalityFitReason: "Steady planner." }));
    await fitSaved(reload)();
    expect((await reload()).personalityFitScore).toBe(61);
  });

  it("lets only one of two quick submits through, with one fit call", async () => {
    mockType.mockImplementation(async () => {
      await delay(100);
      return aiReply({
        mbtiType: mockType.mock.calls.length === 1 ? "INTJ" : "ENFP",
        responses: [],
      });
    });
    const { submit, reload, talent, job } = await setup();

    const statuses = (await Promise.all([submit(), submit()])).map((r) => r.status).sort();

    expect(statuses).toEqual([200, 409]);
    await fitSaved(reload)();
    expect(mockFit).toHaveBeenCalledTimes(1);
    const saved = await reload();
    expect(mockFit.mock.calls[0]![0].mbtiType).toBe(saved.mbtiType);
    const answers = await testDataSource.getRepository(Answer).find({
      where: { userId: talent.id, jobId: job.id, questionType: QuestionType.Personality },
    });
    expect(answers).toHaveLength(1);
    await waitFor(async () => mockMatch.mock.calls.length > 0);
    expect(mockMatch).toHaveBeenCalledTimes(1);
    expect(mockMatch.mock.calls[0]![0].mbtiType).toBe(saved.mbtiType);
  });

  it("keeps a company-test score saved while the personality AI call was running", async () => {
    const { submit, reload, application } = await setup();
    mockType.mockImplementation(async () => {
      await testDataSource.query(`UPDATE "applications" SET "cultureFitScore" = 55 WHERE id = $1`, [
        application.id,
      ]);
      return aiReply({ mbtiType: "INTJ", responses: [] });
    });

    expect((await submit()).status).toBe(200);
    await fitSaved(reload)();

    const saved = await reload();
    expect(saved.mbtiType).toBe("INTJ");
    expect(saved.cultureFitScore).toBe(55);
  });

  it("keeps a recruiter's status change made while the fit call was running", async () => {
    const { submit, reload, application } = await setup();
    mockFit.mockImplementation(async () => {
      await applications().update(application.id, { status: ApplicationStatus.Rejected });
      return aiReply({ personalityFitScore: 50, personalityFitReason: "Mixed." });
    });

    expect((await submit()).status).toBe(200);
    await fitSaved(reload)();

    expect((await reload()).status).toBe(ApplicationStatus.Rejected);
  });

  it("tells the recruiter while the fit is being worked out", async () => {
    const hold = deferred<unknown>();
    mockFit.mockReturnValue(hold.promise);
    const { submit, reload, application, recruiterToken } = await setup();
    await submit();
    await waitFor(locked);

    const res = await request(app)
      .get(`/v1/applications/${application.id}`)
      .set("Authorization", `Bearer ${recruiterToken}`);

    expect(sentApplication(res).personalityFitPending).toBe(true);
    hold.resolve(aiReply({ personalityFitScore: 70, personalityFitReason: "Fine." }));
    await fitSaved(reload)();
  });
});

describe("POST /v1/applications/:id/personality-fit (recruiter retry)", () => {
  /** An application whose MBTI type is saved but whose fit failed. */
  async function failedFit() {
    mockFit.mockRejectedValue(new Error("AI down"));
    const ctx = await setup();
    await ctx.submit();
    await fitCallFinished();
    mockFit.mockReset();
    mockFit.mockResolvedValue(
      aiReply({ personalityFitScore: 81, personalityFitReason: "Calm under pressure." })
    );
    const retry = (token = ctx.recruiterToken) =>
      request(app)
        .post(`/v1/applications/${ctx.application.id}/personality-fit`)
        .set("Authorization", `Bearer ${token}`);
    return { ...ctx, retry };
  }

  it("works the fit out again and saves it", async () => {
    const { retry, reload } = await failedFit();

    const res = await retry();

    expect(res.status).toBe(200);
    expect(apiData(res)).toEqual({
      personalityFitScore: 81,
      personalityFitReason: "Calm under pressure.",
    });
    const saved = await reload();
    expect(saved.personalityFitScore).toBe(81);
    expect(saved.personalityFitLockedAt).toBeNull();
  });

  it("returns 502 when the AI fails again, and a later retry still works", async () => {
    const { retry, reload } = await failedFit();
    mockFit.mockRejectedValueOnce(new Error("AI down again"));

    const first = await retry();
    expect(first.status).toBe(502);
    expect((first.body as { error: { code: string } }).error.code).toBe("PERSONALITY_FIT_FAILED");
    expect((await reload()).personalityFitLockedAt).toBeNull();

    expect((await retry()).status).toBe(200);
    expect((await reload()).personalityFitScore).toBe(81);
  });

  it("returns 409 while another fit call holds the lock", async () => {
    const { retry, application } = await failedFit();
    await applications().update(application.id, { personalityFitLockedAt: new Date() });

    const res = await retry();

    expect(res.status).toBe(409);
    expect(mockFit).not.toHaveBeenCalled();
    await applications().update(application.id, { personalityFitLockedAt: null });
  });

  it("takes over a lock left behind by a crashed call", async () => {
    const { retry, application } = await failedFit();
    await applications().update(application.id, {
      personalityFitLockedAt: new Date(Date.now() - 10 * 60 * 1000),
    });

    expect((await retry()).status).toBe(200);
  });

  it("calls the AI once for two quick clicks", async () => {
    const { retry } = await failedFit();
    mockFit.mockImplementation(async () => {
      await delay(100);
      return aiReply({ personalityFitScore: 81, personalityFitReason: "Calm under pressure." });
    });

    const statuses = (await Promise.all([retry(), retry()])).map((r) => r.status).sort();

    expect(statuses).toEqual([200, 409]);
    expect(mockFit).toHaveBeenCalledTimes(1);
  });

  it("returns the saved fit without calling the AI when there is one", async () => {
    const { retry, application } = await failedFit();
    await applications().update(application.id, {
      personalityFitScore: 40,
      personalityFitReason: "Already done.",
    });

    const res = await retry();

    expect(res.status).toBe(200);
    expect(apiData(res)).toEqual({
      personalityFitScore: 40,
      personalityFitReason: "Already done.",
    });
    expect(mockFit).not.toHaveBeenCalled();
  });

  it("returns 400 before the candidate has a personality type", async () => {
    const { application, recruiterToken } = await setup();

    const res = await request(app)
      .post(`/v1/applications/${application.id}/personality-fit`)
      .set("Authorization", `Bearer ${recruiterToken}`);

    expect(res.status).toBe(400);
    expect(mockFit).not.toHaveBeenCalled();
  });

  it("returns 400 when the job's personality check is switched off", async () => {
    const { retry, job } = await failedFit();
    const { aiConfigId } = await testDataSource.getRepository(Job).findOneByOrFail({ id: job.id });
    await testDataSource
      .getRepository(AIConfig)
      .update(aiConfigId!, { personalityEvaluation: false });

    expect((await retry()).status).toBe(400);
    expect(mockFit).not.toHaveBeenCalled();
  });

  it("refuses another company's recruiter and the candidate", async () => {
    const { retry, talentToken } = await failedFit();
    const { token: outsider } = await createRecruiter();

    expect((await retry(outsider)).status).toBe(403);
    expect((await retry(talentToken)).status).toBe(403);
    expect(mockFit).not.toHaveBeenCalled();
  });
});

describe("AddPersonalityFitLockToApplications migration", () => {
  it("adds the nullable lock column and removes it on down", async () => {
    const queries: string[] = [];
    const runner = {
      query: (sql: string) => Promise.resolve(void queries.push(sql)),
    } as unknown as QueryRunner;
    await new AddPersonalityFitLockToApplications1789001250000().up(runner);
    expect(queries).toEqual([
      `ALTER TABLE "applications" ADD "personalityFitLockedAt" TIMESTAMP WITH TIME ZONE`,
    ]);
    queries.length = 0;
    await new AddPersonalityFitLockToApplications1789001250000().down(runner);
    expect(queries).toEqual([`ALTER TABLE "applications" DROP COLUMN "personalityFitLockedAt"`]);
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
