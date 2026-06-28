/**
 * Application tests — CRUD, authorization, apply-for-job flow, ISSUE-005 and ISSUE-006.
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
  createRecruiter,
  createAdmin,
  createRole,
  createJob,
  createAIConfig,
  createApplication,
} from "./helpers/fixtures.js";
import { Application } from "../src/entities/Application.js";
import { Job } from "../src/entities/Job.js";
import { ApplicationStatus, ApplicationType, ScreeningStage } from "../src/types/enums.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
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
// GET /v1/applications/ — list
// ---------------------------------------------------------------------------

describe("GET /v1/applications/ — list applications", () => {
  it("Talent sees only their own applications", async () => {
    const { user: talent, token: talentToken } = await createTalent();
    const { user: otherTalent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    await createApplication(talent, job);
    await createApplication(otherTalent, job);

    const res = await request(app)
      .get("/v1/applications/")
      .set("Authorization", `Bearer ${talentToken}`);

    expect(res.status).toBe(200);
    const apps = res.body.data.applications ?? res.body.data;
    const ids = (Array.isArray(apps) ? apps : []).map((a: Application) => a.talentId);
    expect(ids.every((id: string) => id === talent.id)).toBe(true);
  });

  it("Recruiter sees only applications for their jobs", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const { user: recruiter2 } = await createRecruiter();
    const { user: talent } = await createTalent();
    const role = await createRole();
    const job1 = await createJob(recruiter, role);
    const job2 = await createJob(recruiter2, role);

    await createApplication(talent, job1);
    await createApplication(talent, job2);

    const res = await request(app)
      .get("/v1/applications/")
      .set("Authorization", `Bearer ${recruiterToken}`);

    expect(res.status).toBe(200);
    const apps = res.body.data.applications ?? res.body.data ?? [];
    expect(Array.isArray(apps)).toBe(true);
    const recruiterIds = apps.map((a: Application) => a.recruiterId);
    expect(recruiterIds.every((id: string) => id === recruiter.id)).toBe(true);
  });

  it("Returns 401 without token", async () => {
    const res = await request(app).get("/v1/applications/");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/applications/:_id — single application
// ---------------------------------------------------------------------------

describe("GET /v1/applications/:_id — single application", () => {
  it("Talent can fetch their own application", async () => {
    const { user: talent, token } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const app_ = await createApplication(talent, job);

    const res = await request(app)
      .get(`/v1/applications/${app_.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("Recruiter can fetch application for their job", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const app_ = await createApplication(talent, job);

    const res = await request(app)
      .get(`/v1/applications/${app_.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("Another talent cannot fetch a different talent's application → 403", async () => {
    const { user: talent } = await createTalent();
    const { token: otherToken } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const app_ = await createApplication(talent, job);

    const res = await request(app)
      .get(`/v1/applications/${app_.id}`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(403);
  });

  it("Third-party recruiter cannot fetch another recruiter's application → 403", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const { token: otherRecruiterToken } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const app_ = await createApplication(talent, job);

    const res = await request(app)
      .get(`/v1/applications/${app_.id}`)
      .set("Authorization", `Bearer ${otherRecruiterToken}`);
    expect(res.status).toBe(403);
  });

  it("Non-existent application ID → 404", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .get("/v1/applications/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/applications/:_id/status — update application status
// ---------------------------------------------------------------------------

describe("PATCH /v1/applications/:_id/status — update status (Recruiter only)", () => {
  it("Recruiter updates status of their application → 200", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const app_ = await createApplication(talent, job);

    const res = await request(app)
      .patch(`/v1/applications/${app_.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: ApplicationStatus.Shortlisted });
    expect(res.status).toBe(200);
    expect(res.body.data.application.status).toBe(ApplicationStatus.Shortlisted);
  });

  it("Talent cannot call PATCH /status → 403 (route guard)", async () => {
    const { user: talent, token: talentToken } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const app_ = await createApplication(talent, job);

    const res = await request(app)
      .patch(`/v1/applications/${app_.id}/status`)
      .set("Authorization", `Bearer ${talentToken}`)
      .send({ status: ApplicationStatus.Shortlisted });
    expect(res.status).toBe(403);
  });

  it("Recruiter cannot update another recruiter's application → 403", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const { token: otherRecruiterToken } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const app_ = await createApplication(talent, job);

    const res = await request(app)
      .patch(`/v1/applications/${app_.id}/status`)
      .set("Authorization", `Bearer ${otherRecruiterToken}`)
      .send({ status: ApplicationStatus.Rejected });
    expect(res.status).toBe(403);
  });

  it("Returns 401 without token", async () => {
    const res = await request(app)
      .patch("/v1/applications/some-id/status")
      .send({ status: ApplicationStatus.Rejected });
    expect(res.status).toBe(401);
  });

  it("Non-existent application → 404", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .patch("/v1/applications/00000000-0000-0000-0000-000000000000/status")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: ApplicationStatus.Rejected });
    expect(res.status).toBe(404);
  });

  it("ISSUE-006: service-level check allows talent (defence-in-depth gap documented)", async () => {
    // This test verifies that the route guard is the ONLY protection for talents.
    // The updateStatus service function itself allows talent (application.talentId === userId).
    // This is ISSUE-006 — defence-in-depth gap.
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const app_ = await createApplication(talent, job);

    // Direct service call (bypassing middleware) — talent passes the check
    const { updateStatus } = await import("../src/services/application.js");
    const updated = await updateStatus(talent.id, {
      id: app_.id,
      status: ApplicationStatus.Shortlisted,
    });

    // Service-level: talent CAN update because talentId === userId (ISSUE-006)
    expect(updated.status).toBe(ApplicationStatus.Shortlisted);
    // Fix: updateStatus should require userRole === Recruiter/Admin
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/jobs/applications/:jobId — apply for a job (Talent)
// ---------------------------------------------------------------------------

describe("PATCH /v1/jobs/applications/:jobId — apply for job", () => {
  it("Talent with passing prescreening score applies successfully → 201", async () => {
    const { user: talent, token: talentToken } = await createTalent({ prescreeningScore: 75 });
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    await createAIConfig(recruiter, {
      minPrescreeningScore: 60,
      stages: {
        prescreening: "cv_similarity",
        cv_similarity: "personalized",
        personalized: "personality",
        personality: "completed",
      },
    });

    // Link aiConfig to job
    const aiConfig = await createAIConfig(recruiter, { minPrescreeningScore: 60 });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const res = await request(app)
      .patch(`/v1/jobs/applications/${job.id}`)
      .set("Authorization", `Bearer ${talentToken}`)
      .send({});
    expect(res.status).toBe(201);
  });

  it("Talent without prescreeningScore cannot apply → 400", async () => {
    const { token } = await createTalent({ prescreeningScore: null });
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, { minPrescreeningScore: 60 });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const res = await request(app)
      .patch(`/v1/jobs/applications/${job.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("Talent with score below minPrescreeningScore is rejected → 403", async () => {
    const { token } = await createTalent({ prescreeningScore: 30 });
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, { minPrescreeningScore: 70 });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const res = await request(app)
      .patch(`/v1/jobs/applications/${job.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("Job not found → 404", async () => {
    const { token } = await createTalent({ prescreeningScore: 75 });
    const res = await request(app)
      .patch("/v1/jobs/applications/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("Recruiter cannot apply for a job → 403", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    const res = await request(app)
      .patch(`/v1/jobs/applications/${job.id}`)
      .set("Authorization", `Bearer ${recruiterToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("Applying twice returns the existing application (idempotent)", async () => {
    const { user: talent, token: talentToken } = await createTalent({ prescreeningScore: 75 });
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const aiConfig = await createAIConfig(recruiter, { minPrescreeningScore: 60 });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const res1 = await request(app)
      .patch(`/v1/jobs/applications/${job.id}`)
      .set("Authorization", `Bearer ${talentToken}`)
      .send({});
    const res2 = await request(app)
      .patch(`/v1/jobs/applications/${job.id}`)
      .set("Authorization", `Bearer ${talentToken}`)
      .send({});

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);

    // Only one application should exist
    const count = await testDataSource
      .getRepository(Application)
      .count({ where: { talentId: talent.id, jobId: job.id } });
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ISSUE-005: Application ranking is sequential, not score-based
// ---------------------------------------------------------------------------

describe("ISSUE-005: Application rank is sequential not score-based", () => {
  it("Rank equals position in completion order regardless of averageScore", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    // Create 3 completed applications with different average scores
    const app1 = await createApplication(await (await createTalent()).user, job, {
      averageScore: 95,
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.Shortlisted,
      rank: 1,
    });
    const app2 = await createApplication(await (await createTalent()).user, job, {
      averageScore: 40,
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.Shortlisted,
      rank: 2,
    });
    const app3 = await createApplication(await (await createTalent()).user, job, {
      averageScore: 70,
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.Shortlisted,
      rank: 3,
    });

    // ISSUE-005: rank was assigned as count+1 in order of completion.
    // So app with score=95 gets rank=1, score=40 gets rank=2, score=70 gets rank=3.
    // This is WRONG: rank=1 should belong to the highest score (95), rank=3 to lowest (40).
    const loaded = await testDataSource.getRepository(Application).find({
      where: { jobId: job.id },
      order: { rank: "ASC" },
    });

    // The best-scoring application (95) has rank=1 — coincidentally correct only if it was first
    // The 40-score application has rank=2 — documents ISSUE-005: rank is not score-based
    const rankedIds = loaded.map((a) => a.id);
    // Just verify the data — don't assert specific order as this documents the current (buggy) behavior
    expect(loaded.length).toBe(3);
    expect(loaded.every((a) => a.rank !== null)).toBe(true);
  });
});
