/**
 * AI Config CRUD tests — recruiter isolation, stage computation, ownership,
 * required-jobId linking, and resyncing untouched applications on edit.
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import { startTestDatabase, stopTestDatabase, clearAllTables, testDataSource } from "./helpers/db.js";
import {
  createTalent,
  createRecruiter,
  createAdmin,
  createAIConfig,
  createJob,
  createRole,
  createApplication,
} from "./helpers/fixtures.js";
import { Job } from "../src/entities/Job.js";
import { Application } from "../src/entities/Application.js";
import { Answer } from "../src/entities/Answer.js";
import { JobStatus, QuestionType, ScreeningStage } from "../src/types/enums.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
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
  name: "Test Config",
  prescreeningAssessment: true,
  minPrescreeningScore: 60,
  cvSimilarity: true,
  minCvSimilarityScore: 50,
  personalizedAssessment: true,
  noPersonalizedQuestions: 2,
  personalityEvaluation: true,
  noOfEIQuestions: 3,
};

// ---------------------------------------------------------------------------
// POST /v1/ai-config/ — create AI config (Recruiter/Admin)
// ---------------------------------------------------------------------------

describe("POST /v1/ai-config/ — create AI config", () => {
  it("Recruiter creates a config → 201", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    const res = await request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...baseConfigBody, jobId: job.id });
    expect(res.status).toBe(201);
    expect(res.body.data.aiConfig).toBeDefined();
  });

  it("Admin can create config → 201", async () => {
    const { user: admin, token } = await createAdmin();
    const role = await createRole();
    const job = await createJob(admin, role);

    const res = await request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...baseConfigBody, name: "Admin Config", jobId: job.id });
    expect(res.status).toBe(201);
  });

  it("Talent cannot create → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send(baseConfigBody);
    expect(res.status).toBe(403);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app).post("/v1/ai-config/").send(baseConfigBody);
    expect(res.status).toBe(401);
  });

  it("Stages are computed from assessment flags on create", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    const res = await request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        ...baseConfigBody,
        jobId: job.id,
        prescreeningAssessment: true,
        cvSimilarity: true,
        personalizedAssessment: false,
        personalityEvaluation: false,
      });
    expect(res.status).toBe(201);
    const stages = res.body.data.aiConfig.stages;
    expect(stages).toBeDefined();
  });

  it("Missing jobId → 400", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send(baseConfigBody);
    expect(res.status).toBe(400);
  });

  it("Links the created config to the job's aiConfigId", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    const res = await request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...baseConfigBody, jobId: job.id });
    expect(res.status).toBe(201);

    const updatedJob = await testDataSource.getRepository(Job).findOne({ where: { id: job.id } });
    expect(updatedJob!.aiConfigId).toBe(res.body.data.aiConfig.id);
  });

  it("Two configs with the same name on different jobs both succeed → 201, 201", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job1 = await createJob(recruiter, role);
    const job2 = await createJob(recruiter, role);

    const res1 = await request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...baseConfigBody, name: "Standard Screening", jobId: job1.id });
    expect(res1.status).toBe(201);

    const res2 = await request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...baseConfigBody, name: "Standard Screening", jobId: job2.id });
    expect(res2.status).toBe(201);
  });

  it("Two configs with no name on different jobs both succeed → 201, 201", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job1 = await createJob(recruiter, role);
    const job2 = await createJob(recruiter, role);
    const { name: _name, ...bodyWithoutName } = baseConfigBody;

    const res1 = await request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...bodyWithoutName, jobId: job1.id });
    expect(res1.status).toBe(201);

    const res2 = await request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...bodyWithoutName, jobId: job2.id });
    expect(res2.status).toBe(201);
  });

  it("noOfCvSimilarCandidates is no longer accepted or returned", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    const res = await request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...baseConfigBody, jobId: job.id, noOfCvSimilarCandidates: 10 });
    expect(res.status).toBe(201);
    expect(res.body.data.aiConfig.noOfCvSimilarCandidates).toBeUndefined();
  });

  it("Missing minPrescreeningScore → 400", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { minPrescreeningScore: _score, ...bodyWithoutScore } = baseConfigBody;

    const res = await request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...bodyWithoutScore, jobId: job.id });
    expect(res.status).toBe(400);
  });

  it("prescreeningAssessment is always forced true server-side", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    const res = await request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...baseConfigBody, jobId: job.id, prescreeningAssessment: false });
    expect(res.status).toBe(201);
    expect(res.body.data.aiConfig.prescreeningAssessment).toBe(true);
  });

  it("Personality evaluation enabled with zero dichotomy counts → 400", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { noOfEIQuestions: _ei, ...bodyWithoutCounts } = baseConfigBody;

    const res = await request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...bodyWithoutCounts, jobId: job.id, personalityEvaluation: true });
    expect(res.status).toBe(400);
  });

  it("Personality evaluation enabled with exactly one dichotomy count → 201", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    const res = await request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...baseConfigBody, jobId: job.id, personalityEvaluation: true, noOfEIQuestions: 3 });
    expect(res.status).toBe(201);
  });

  it("Personality evaluation disabled with zero dichotomy counts → 201", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { noOfEIQuestions: _ei, ...bodyWithoutCounts } = baseConfigBody;

    const res = await request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...bodyWithoutCounts, jobId: job.id, personalityEvaluation: false });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/ai-config/ — list AI configs (Recruiter/Admin)
// ---------------------------------------------------------------------------

describe("GET /v1/ai-config/ — list AI configs", () => {
  it("Recruiter sees their own configs → 200", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const { user: recruiter2 } = await createRecruiter();

    await createAIConfig(recruiter);
    await createAIConfig(recruiter2);

    const res = await request(app)
      .get("/v1/ai-config/")
      .set("Authorization", `Bearer ${recruiterToken}`);

    expect(res.status).toBe(200);
    const configs = res.body.data.aiConfigs ?? res.body.data ?? [];
    expect(Array.isArray(configs)).toBe(true);
    expect(configs.every((c: { recruiterId: string }) => c.recruiterId === recruiter.id)).toBe(
      true
    );
  });

  it("Talent cannot access → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app).get("/v1/ai-config/").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app).get("/v1/ai-config/");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/ai-config/:_id — single AI config (Recruiter/Admin)
// ---------------------------------------------------------------------------

describe("GET /v1/ai-config/:_id — single AI config", () => {
  it("Owner recruiter fetches their config → 200", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const config = await createAIConfig(recruiter);

    const res = await request(app)
      .get(`/v1/ai-config/${config.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("Another recruiter cannot fetch → 403", async () => {
    const { user: recruiter } = await createRecruiter();
    const { token: otherToken } = await createRecruiter();
    const config = await createAIConfig(recruiter);

    const res = await request(app)
      .get(`/v1/ai-config/${config.id}`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(403);
  });

  it("Non-existent → 404", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .get("/v1/ai-config/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/ai-config/:_id — update AI config (Recruiter/Admin)
// ---------------------------------------------------------------------------

describe("PATCH /v1/ai-config/:_id — update AI config", () => {
  it("Owner recruiter updates their config → 200", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const config = await createAIConfig(recruiter, { name: "Old Name" });

    const res = await request(app)
      .patch(`/v1/ai-config/${config.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Updated Name" });

    expect(res.status).toBe(200);
    expect(res.body.data.aiConfig).toBeDefined();
  });

  it("Non-owner recruiter cannot update → 403", async () => {
    const { user: recruiter } = await createRecruiter();
    const { token: otherToken } = await createRecruiter();
    const config = await createAIConfig(recruiter);

    const res = await request(app)
      .patch(`/v1/ai-config/${config.id}`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ name: "Hack" });
    expect(res.status).toBe(403);
  });

  it("Non-existent → 404", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .patch("/v1/ai-config/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "X" });
    expect(res.status).toBe(404);
  });

  it("Renaming to a name already used by another of the recruiter's configs → 200", async () => {
    const { user: recruiter, token } = await createRecruiter();
    await createAIConfig(recruiter, { name: "Alpha" });
    const configB = await createAIConfig(recruiter, { name: "Beta" });

    const res = await request(app)
      .patch(`/v1/ai-config/${configB.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Alpha" });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/ai-config/:_id — resync untouched applications
// ---------------------------------------------------------------------------

describe("PATCH /v1/ai-config/:_id — resync untouched applications", () => {
  const linkConfig = async (job: Job, configId: string) => {
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: configId });
  };

  it("Recomputes stages/currentStage for an untouched application when config flags change", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const { user: talent } = await createTalent();
    const role = await createRole();
    const job = await createJob(recruiter, role, { status: JobStatus.Active });
    const config = await createAIConfig(recruiter, {
      personalityEvaluation: true,
      personalizedAssessment: false,
      prescreeningAssessment: true,
      cvSimilarity: false,
    });
    await linkConfig(job, config.id);
    await createApplication(talent, job, {
      currentStage: ScreeningStage.Personality,
      stages: config.stages ?? {},
    });

    const res = await request(app)
      .patch(`/v1/ai-config/${config.id}`)
      .set("Authorization", `Bearer ${recruiterToken}`)
      .send({ personalityEvaluation: false, personalizedAssessment: true, noPersonalizedQuestions: 2 });
    expect(res.status).toBe(200);

    const updatedApplication = await testDataSource
      .getRepository(Application)
      .findOne({ where: { talentId: talent.id, jobId: job.id } });
    expect(updatedApplication!.currentStage).toBe(ScreeningStage.Personalized);
  });

  it("Leaves an application alone if it has a Personality Answer row", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const { user: talent } = await createTalent();
    const role = await createRole();
    const job = await createJob(recruiter, role, { status: JobStatus.Active });
    const config = await createAIConfig(recruiter, {
      personalityEvaluation: true,
      personalizedAssessment: false,
    });
    await linkConfig(job, config.id);
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Personality,
      stages: config.stages ?? {},
    });
    await testDataSource.getRepository(Answer).save(
      testDataSource.getRepository(Answer).create({
        userId: talent.id,
        jobId: job.id,
        questionType: QuestionType.Personality,
        responses: [{ questionId: "q1", answer: "I recharge alone.", dichotomyPreference: "I" }],
      })
    );

    const res = await request(app)
      .patch(`/v1/ai-config/${config.id}`)
      .set("Authorization", `Bearer ${recruiterToken}`)
      .send({ personalityEvaluation: false, personalizedAssessment: true, noPersonalizedQuestions: 2 });
    expect(res.status).toBe(200);

    const untouched = await testDataSource
      .getRepository(Application)
      .findOne({ where: { id: application.id } });
    expect(untouched!.currentStage).toBe(ScreeningStage.Personality);
  });

  it("Leaves an application alone if it has a Personalized Answer row", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const { user: talent } = await createTalent();
    const role = await createRole();
    const job = await createJob(recruiter, role, { status: JobStatus.Active });
    const config = await createAIConfig(recruiter, {
      personalityEvaluation: true,
      personalizedAssessment: true,
    });
    await linkConfig(job, config.id);
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Personality,
      stages: config.stages ?? {},
    });
    await testDataSource.getRepository(Answer).save(
      testDataSource.getRepository(Answer).create({
        userId: talent.id,
        jobId: job.id,
        questionType: QuestionType.Personalized,
        responses: [{ questionId: "q1", answer: "I shipped X at my last job." }],
      })
    );

    const res = await request(app)
      .patch(`/v1/ai-config/${config.id}`)
      .set("Authorization", `Bearer ${recruiterToken}`)
      .send({ personalityEvaluation: false });
    expect(res.status).toBe(200);

    const untouched = await testDataSource
      .getRepository(Application)
      .findOne({ where: { id: application.id } });
    expect(untouched!.currentStage).toBe(ScreeningStage.Personality);
  });

  it("Leaves an application alone if it already has a recorded score/mbtiType", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const { user: talent } = await createTalent();
    const role = await createRole();
    const job = await createJob(recruiter, role, { status: JobStatus.Active });
    const config = await createAIConfig(recruiter, { personalityEvaluation: true });
    await linkConfig(job, config.id);
    const application = await createApplication(talent, job, {
      currentStage: ScreeningStage.Personality,
      stages: config.stages ?? {},
      mbtiType: "INTJ",
    });

    const res = await request(app)
      .patch(`/v1/ai-config/${config.id}`)
      .set("Authorization", `Bearer ${recruiterToken}`)
      .send({ personalityEvaluation: false, personalizedAssessment: true, noPersonalizedQuestions: 2 });
    expect(res.status).toBe(200);

    const untouched = await testDataSource
      .getRepository(Application)
      .findOne({ where: { id: application.id } });
    expect(untouched!.currentStage).toBe(ScreeningStage.Personality);
  });

  it("Only resyncs applications on jobs linked to the edited config", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const { user: talentA } = await createTalent();
    const { user: talentB } = await createTalent();
    const role = await createRole();

    const jobA = await createJob(recruiter, role, { status: JobStatus.Active });
    const configA = await createAIConfig(recruiter, {
      personalityEvaluation: true,
      personalizedAssessment: false,
    });
    await linkConfig(jobA, configA.id);
    await createApplication(talentA, jobA, {
      currentStage: ScreeningStage.Personality,
      stages: configA.stages ?? {},
    });

    const jobB = await createJob(recruiter, role, { status: JobStatus.Active });
    const configB = await createAIConfig(recruiter, {
      personalityEvaluation: true,
      personalizedAssessment: false,
    });
    await linkConfig(jobB, configB.id);
    const applicationB = await createApplication(talentB, jobB, {
      currentStage: ScreeningStage.Personality,
      stages: configB.stages ?? {},
    });

    const res = await request(app)
      .patch(`/v1/ai-config/${configA.id}`)
      .set("Authorization", `Bearer ${recruiterToken}`)
      .send({ personalityEvaluation: false, personalizedAssessment: true, noPersonalizedQuestions: 2 });
    expect(res.status).toBe(200);

    const untouchedB = await testDataSource
      .getRepository(Application)
      .findOne({ where: { id: applicationB.id } });
    expect(untouchedB!.currentStage).toBe(ScreeningStage.Personality);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/ai-config/:_id — delete AI config (Recruiter/Admin)
// ---------------------------------------------------------------------------

describe("DELETE /v1/ai-config/:_id — delete AI config", () => {
  it("Owner recruiter deletes their config → 200", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const config = await createAIConfig(recruiter);

    const res = await request(app)
      .delete(`/v1/ai-config/${config.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("Non-owner recruiter cannot delete → 403", async () => {
    const { user: recruiter } = await createRecruiter();
    const { token: otherToken } = await createRecruiter();
    const config = await createAIConfig(recruiter);

    const res = await request(app)
      .delete(`/v1/ai-config/${config.id}`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(403);
  });

  it("Non-existent → 404", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .delete("/v1/ai-config/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("Talent cannot delete → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .delete("/v1/ai-config/some-id")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
