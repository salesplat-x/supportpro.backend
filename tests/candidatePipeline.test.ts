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
} from "./helpers/fixtures.js";
import { Application } from "../src/entities/Application.js";
import { AiInterview } from "../src/entities/AiInterview.js";
import { AiInterviewQuestion } from "../src/entities/AiInterviewQuestion.js";
import { ApplicationReference } from "../src/entities/ApplicationReference.js";
import type { AIConfig } from "../src/entities/AIConfig.js";
import type { User } from "../src/entities/User.js";
import { ApplicationStatus, ScreeningStage } from "../src/types/enums.js";
import { createStages } from "../src/services/aiConfig.js";
import type { CandidatePipeline, PipelineStep } from "../src/services/candidatePipeline.js";
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
  generateAiInterviewQuestions: jest.fn().mockResolvedValue(undefined),
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
});

const DAY = 24 * 60 * 60 * 1000;

const SWITCHES: Partial<AIConfig> = {
  prescreeningAssessment: true,
  minPrescreeningScore: 60,
  cvSimilarity: false,
  personalizedAssessment: false,
  problemSolvingAssessment: true,
  noOfProblemSolvingQuestions: 8,
  cultureFitAssessment: true,
  noOfCultureFitQuestions: 5,
  personalityEvaluation: false,
  aiInterview: true,
  aiInterviewMode: "audio",
};

async function setup(
  stage: ScreeningStage,
  overrides: Partial<Application> = {},
  switches: Partial<AIConfig> = {},
  talentOverrides: Partial<User> = {}
) {
  const { user: recruiter, token: recruiterToken } = await createRecruiter();
  const merged = { ...SWITCHES, ...switches };
  const { stages } = createStages(merged);
  const config = await createAIConfig(recruiter, { ...merged, stages });
  const job = await createJob(recruiter, await createRole("Product Designer"), {
    aiConfigId: config.id,
    organizationId: recruiter.activeOrganizationId!,
    locationCity: "Lekki",
    workMode: ["hybrid"],
  });
  const { user: talent, token } = await createCompleteTalent(undefined, talentOverrides);
  const application = await createApplication(talent, job, {
    stages,
    currentStage: stage,
    ...overrides,
  });
  return { recruiter, recruiterToken, config, job, talent, token, application };
}

const getPipeline = (token: string, id: string) =>
  request(app).get(`/v1/user/applications/${id}/pipeline`).set("Authorization", `Bearer ${token}`);

const pipelineOf = async (token: string, id: string) => {
  const res = await getPipeline(token, id);
  expect(res.status).toBe(200);
  return apiData<CandidatePipeline>(res);
};

const step = (pipeline: CandidatePipeline, key: PipelineStep["key"]) =>
  pipeline.steps.find((s) => s.key === key);

const reload = (id: string) => testDataSource.getRepository(Application).findOneByOrFail({ id });

const HIDDEN = [
  "problemSolvingScore",
  "cultureFitScore",
  "personalityFitScore",
  "minPrescreeningScore",
  "minCvSimilarityScore",
  "correctOption",
  "recruiterGuide",
];

describe("GET /v1/user/applications/:applicationId/pipeline — access", () => {
  it("only the candidate who applied can read it; anyone else gets 404, recruiters 403", async () => {
    const { token, recruiterToken, application } = await setup(ScreeningStage.Prescreening);
    const { token: otherToken } = await createCompleteTalent();

    expect((await getPipeline(token, application.id)).status).toBe(200);
    expect((await getPipeline(otherToken, application.id)).status).toBe(404);
    expect((await getPipeline(recruiterToken, application.id)).status).toBe(403);
    expect((await getPipeline(token, "8b1d3c3e-1b7a-4a59-9a5c-1f0f8f0e2a11")).status).toBe(404);
    expect((await getPipeline(token, "not-a-uuid")).status).toBe(400);
  });

  it("never sends hidden scores, pass marks or answers", async () => {
    const { token, application } = await setup(ScreeningStage.ProblemSolving);
    await testDataSource.query(
      `UPDATE "applications" SET "problemSolvingScore" = 40, "cultureFitScore" = 30, "personalityFitScore" = 20 WHERE id = $1`,
      [application.id]
    );
    const body = JSON.stringify((await getPipeline(token, application.id)).body);
    for (const field of HIDDEN) expect(body).not.toContain(field);
  });
});

describe("GET /v1/user/applications/:applicationId/pipeline — steps", () => {
  it("a fresh application: the skills test is current and due 3 days after applying", async () => {
    const { token, application } = await setup(ScreeningStage.Prescreening);

    const pipeline = await pipelineOf(token, application.id);

    expect(pipeline.steps.map((s) => s.key)).toEqual([
      "applied",
      "skills_test",
      "problem_solving",
      "culture_fit",
      "ai_interview",
      "company_review",
    ]);
    expect(pipeline.steps.map((s) => s.state)).toEqual([
      "done",
      "current",
      "upcoming",
      "upcoming",
      "upcoming",
      "upcoming",
    ]);
    expect(pipeline.currentStep).toBe(2);
    expect(pipeline.totalSteps).toBe(6);
    expect(pipeline.nextStep?.key).toBe("skills_test");
    const applied = new Date(pipeline.application.appliedAt).getTime();
    expect(new Date(step(pipeline, "skills_test")!.dueAt!).getTime()).toBe(applied + 3 * DAY);
    expect(step(pipeline, "skills_test")!.minutes).toBe(10);
    expect(step(pipeline, "problem_solving")).toMatchObject({
      questionCount: 8,
      minutes: 11,
      isNew: true,
      dueAt: null,
    });
    expect(step(pipeline, "culture_fit")).toMatchObject({ questionCount: 5, minutes: 6 });
    expect(pipeline.application).toMatchObject({
      candidateStatus: "test_to_take",
      group: "needs_you",
    });
    expect(pipeline.application.job).toMatchObject({
      title: "Product Designer",
      locationCity: "Lekki",
      workMode: ["hybrid"],
    });
  });

  it("a valid passing skills score moves the candidate on and shows the score", async () => {
    const { token, application } = await setup(
      ScreeningStage.Prescreening,
      {},
      {},
      {
        prescreeningScore: 81,
        prescreeningScoredAt: new Date(),
      }
    );

    const pipeline = await pipelineOf(token, application.id);

    expect(step(pipeline, "skills_test")).toMatchObject({ state: "done", score: 81, passed: true });
    expect(pipeline.nextStep?.key).toBe("problem_solving");
    expect((await reload(application.id)).currentStage).toBe(ScreeningStage.ProblemSolving);
  });

  it("a failing score starts one retake wait, and reading again doesn't push it back", async () => {
    const { token, application } = await setup(
      ScreeningStage.Prescreening,
      {},
      {},
      {
        prescreeningScore: 40,
        prescreeningScoredAt: new Date(),
      }
    );

    const first = await pipelineOf(token, application.id);
    const retryAt = step(first, "skills_test")!.retryAt;
    expect(retryAt).not.toBeNull();
    expect(first.application.candidateStatus).toBe("screening");
    const second = await pipelineOf(token, application.id);
    expect(step(second, "skills_test")!.retryAt).toBe(retryAt);
    expect((await reload(application.id)).status).toBe(ApplicationStatus.RetakeAssessment);
  });

  it("the current test is due 2 days after it opened and stops being new once loaded", async () => {
    const { token, application } = await setup(ScreeningStage.ProblemSolving);
    const opened = new Date(Date.now() - DAY);
    await testDataSource.query(`UPDATE "applications" SET "stageReachedAt" = $1 WHERE id = $2`, [
      JSON.stringify({ problem_solving: opened.toISOString() }),
      application.id,
    ]);

    let pipeline = await pipelineOf(token, application.id);
    expect(step(pipeline, "problem_solving")).toMatchObject({ state: "current", isNew: true });
    expect(new Date(step(pipeline, "problem_solving")!.dueAt!).getTime()).toBe(
      opened.getTime() + 2 * DAY
    );

    await testDataSource.query(
      `UPDATE "applications" SET "problemSolvingQuestions" = 'a,b,c' WHERE id = $1`,
      [application.id]
    );
    pipeline = await pipelineOf(token, application.id);
    expect(step(pipeline, "problem_solving")).toMatchObject({ isNew: false, questionCount: 3 });
  });

  it("an interview to record: interview to do, references appear, and recording completes it", async () => {
    const { token, job, talent, application } = await setup(ScreeningStage.AiInterview, {
      problemSolvingQuestions: ["a"],
      cultureFitQuestions: ["b"],
    });
    await testDataSource.query(
      `UPDATE "applications" SET "problemSolvingScore" = 70, "cultureFitScore" = 60 WHERE id = $1`,
      [application.id]
    );
    const invitedAt = new Date(Date.now() - DAY);
    const interview = await testDataSource.getRepository(AiInterview).save({
      applicationId: application.id,
      jobId: job.id,
      talentId: talent.id,
      mode: "audio",
      status: "invited",
      invitedAt,
    });
    const questions = testDataSource.getRepository(AiInterviewQuestion);
    for (let position = 1; position <= 2; position++) {
      await questions.save({
        interviewId: interview.id,
        position,
        isFollowUp: false,
        question: `Q${position}?`,
      });
    }

    let pipeline = await pipelineOf(token, application.id);
    expect(pipeline.steps.map((s) => s.key)).toEqual([
      "applied",
      "skills_test",
      "problem_solving",
      "culture_fit",
      "ai_interview",
      "references",
      "company_review",
    ]);
    expect(step(pipeline, "ai_interview")).toMatchObject({
      state: "current",
      interviewId: interview.id,
      minutes: 15,
    });
    expect(new Date(step(pipeline, "ai_interview")!.dueAt!).getTime()).toBe(
      invitedAt.getTime() + 7 * DAY
    );
    expect(step(pipeline, "references")).toMatchObject({ state: "upcoming", maxReferees: 3 });
    expect(pipeline.currentStep).toBe(5);
    expect(pipeline.totalSteps).toBe(7);
    expect(pipeline.application.candidateStatus).toBe("interview_to_do");

    await questions.update({ interviewId: interview.id }, { recordedAt: new Date() });
    pipeline = await pipelineOf(token, application.id);
    expect(step(pipeline, "ai_interview")!.state).toBe("done");
    expect(pipeline.nextStep?.key).toBe("references");
    expect(pipeline.application.candidateStatus).toBe("screening");

    await testDataSource.getRepository(ApplicationReference).save({
      applicationId: application.id,
      jobId: job.id,
      talentId: talent.id,
      name: "Ref",
      email: "ref@example.com",
      relationship: "Manager",
      tokenHash: "x",
      tokenExpiresAt: new Date(Date.now() + DAY),
    });
    pipeline = await pipelineOf(token, application.id);
    expect(step(pipeline, "references")).toMatchObject({ state: "done", refereeCount: 1 });
    expect(pipeline.nextStep?.key).toBe("company_review");
  });

  it("tests the candidate has moved past count as done even without a score on record", async () => {
    const { token, application } = await setup(ScreeningStage.AiInterview);
    const pipeline = await pipelineOf(token, application.id);
    expect(step(pipeline, "problem_solving")).toMatchObject({ state: "done", isNew: false });
    expect(step(pipeline, "culture_fit")!.state).toBe("done");
    expect(pipeline.nextStep?.key).toBe("ai_interview");
  });

  it("a rejected application is closed, with the decision on the last step and nothing current", async () => {
    const { token, application } = await setup(ScreeningStage.ProblemSolving, {
      status: ApplicationStatus.NotProceeding,
    });
    const pipeline = await pipelineOf(token, application.id);
    expect(pipeline.application).toMatchObject({
      candidateStatus: "not_proceeding",
      group: "closed",
    });
    expect(step(pipeline, "company_review")).toMatchObject({
      state: "done",
      outcome: "not_proceeding",
    });
    expect(pipeline.currentStep).toBeNull();
    expect(pipeline.steps.some((s) => s.state === "current")).toBe(false);
  });

  it("an application made before the tests were stages still lists them after the last earlier step", async () => {
    const { token, application } = await setup(
      ScreeningStage.Personalized,
      {
        stages: { prescreening: "personalized", personalized: "completed" },
        problemSolvingQuestions: ["a"],
      },
      { personalizedAssessment: true, noPersonalizedQuestions: 2 }
    );
    await testDataSource.query(
      `UPDATE "applications" SET "problemSolvingScore" = 50 WHERE id = $1`,
      [application.id]
    );
    const pipeline = await pipelineOf(token, application.id);
    expect(pipeline.steps.map((s) => s.key)).toEqual([
      "applied",
      "skills_test",
      "tailored",
      "problem_solving",
      "culture_fit",
      "company_review",
    ]);
    expect(step(pipeline, "problem_solving")!.state).toBe("done");
    expect(step(pipeline, "tailored")!.state).toBe("current");
  });

  it("moves past a stage the recruiter switched off after the candidate reached it", async () => {
    const { token, config, application } = await setup(ScreeningStage.ProblemSolving);
    await testDataSource
      .getRepository("AIConfig")
      .update(config.id, { problemSolvingAssessment: false });

    const pipeline = await pipelineOf(token, application.id);

    expect((await reload(application.id)).currentStage).toBe(ScreeningStage.CultureFit);
    expect(pipeline.nextStep?.key).toBe("culture_fit");
  });

  it("parallel reads move a settled stage once", async () => {
    const { token, application } = await setup(
      ScreeningStage.Prescreening,
      {},
      {},
      {
        prescreeningScore: 90,
        prescreeningScoredAt: new Date(),
      }
    );

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => getPipeline(token, application.id))
    );

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const saved = await reload(application.id);
    expect(saved.currentStage).toBe(ScreeningStage.ProblemSolving);
    expect(Object.keys(saved.stageReachedAt).sort()).toEqual(
      [ScreeningStage.Prescreening, ScreeningStage.ProblemSolving].sort()
    );
  });
});

describe("PATCH /v1/jobs/applications/:jobId — applying", () => {
  it("moves straight past the skills test when the candidate's score is still valid", async () => {
    const { user: recruiter } = await createRecruiter();
    const { stages } = createStages(SWITCHES);
    const config = await createAIConfig(recruiter, { ...SWITCHES, stages });
    const job = await createJob(recruiter, await createRole(), { aiConfigId: config.id });
    const { token } = await createCompleteTalent(undefined, {
      prescreeningScore: 75,
      prescreeningScoredAt: new Date(),
    });

    const res = await request(app)
      .patch(`/v1/jobs/applications/${job.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(201);
    const { application } = apiData<{ application: Application }>(res);
    expect(application.currentStage).toBe(ScreeningStage.ProblemSolving);
  });
});

describe("GET /v1/user/applications — groups and counts", () => {
  it("counts every group, filters by group and pages after filtering, with no pass marks", async () => {
    const first = await setup(ScreeningStage.Prescreening);
    const recruiter = first.recruiter;
    const talent = first.talent;
    const { stages } = createStages(SWITCHES);
    for (const status of [ApplicationStatus.Pending, ApplicationStatus.NotProceeding]) {
      const job = await createJob(recruiter, await createRole(), {
        aiConfigId: first.config.id,
      });
      await createApplication(talent, job, {
        stages,
        currentStage: ScreeningStage.ProblemSolving,
        status,
      });
    }

    const all = await request(app)
      .get("/v1/user/applications")
      .set("Authorization", `Bearer ${first.token}`);
    expect(all.status).toBe(200);
    const data = apiData<{
      applications: Array<{ candidateStatus: string; group: string }>;
      total: number;
      counts: Record<string, number>;
    }>(all);
    expect(data.counts).toEqual({ all: 3, needs_you: 2, in_progress: 0, closed: 1 });
    expect(data.total).toBe(3);
    const body = JSON.stringify(all.body);
    for (const field of HIDDEN) expect(body).not.toContain(field);

    const page = await request(app)
      .get("/v1/user/applications")
      .query({ group: "needs_you", limit: 1, offset: 1 })
      .set("Authorization", `Bearer ${first.token}`);
    const paged = apiData<typeof data>(page);
    expect(paged.total).toBe(2);
    expect(paged.applications).toHaveLength(1);
    expect(paged.applications[0]!.group).toBe("needs_you");
    expect(paged.counts.all).toBe(3);

    expect(
      (
        await request(app)
          .get("/v1/user/applications")
          .query({ group: "everything" })
          .set("Authorization", `Bearer ${first.token}`)
      ).status
    ).toBe(400);
  });
});
