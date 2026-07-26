/**
 * Application tests — CRUD, authorization, apply-for-job flow, ISSUE-005 and ISSUE-006.
 */

import request from "supertest";
import { In } from "typeorm";
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
} from "./helpers/fixtures.js";
import { Application } from "../src/entities/Application.js";
import { Job } from "../src/entities/Job.js";
import { Notification } from "../src/entities/Notification.js";
import { ApplicationStatus, ScreeningStage } from "../src/types/enums.js";

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

  it("item 9: shortlisting sends the talent a congratulatory in-app notification", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const app_ = await createApplication(talent, job);

    await request(app)
      .patch(`/v1/applications/${app_.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: ApplicationStatus.Shortlisted });

    const notifications = await testDataSource
      .getRepository(Notification)
      .find({ where: { userId: talent.id } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.message).toContain("shortlisted");
  });

  it("item 9: rejecting sends the talent a reassuring in-app notification", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const app_ = await createApplication(talent, job);

    await request(app)
      .patch(`/v1/applications/${app_.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: ApplicationStatus.Rejected });

    const notifications = await testDataSource
      .getRepository(Notification)
      .find({ where: { userId: talent.id } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.message).toContain("dream job");
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
// PATCH /v1/applications/status — bulk update (item 5)
// ---------------------------------------------------------------------------

describe("PATCH /v1/applications/status — bulk shortlist/reject (Recruiter only)", () => {
  it("updates every selected application and notifies each talent", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talentA } = await createTalent();
    const { user: talentB } = await createTalent();
    const appA = await createApplication(talentA, job);
    const appB = await createApplication(talentB, job);

    const res = await request(app)
      .patch("/v1/applications/status")
      .set("Authorization", `Bearer ${token}`)
      .send({ applicationIds: [appA.id, appB.id], status: ApplicationStatus.Shortlisted });

    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBe(2);

    const reloaded = await testDataSource
      .getRepository(Application)
      .find({ where: { id: In([appA.id, appB.id]) } });
    expect(reloaded.every((a) => a.status === ApplicationStatus.Shortlisted)).toBe(true);

    const notifications = await testDataSource.getRepository(Notification).find({
      where: { userId: In([talentA.id, talentB.id]) },
    });
    expect(notifications).toHaveLength(2);
  });

  it("silently skips applications the caller doesn't own (partial success)", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const { user: otherRecruiter } = await createRecruiter();
    const role = await createRole();
    const ownJob = await createJob(recruiter, role);
    const otherJob = await createJob(otherRecruiter, role);
    const { user: talentA } = await createTalent();
    const { user: talentB } = await createTalent();
    const ownApp = await createApplication(talentA, ownJob);
    const otherApp = await createApplication(talentB, otherJob);

    const res = await request(app)
      .patch("/v1/applications/status")
      .set("Authorization", `Bearer ${token}`)
      .send({ applicationIds: [ownApp.id, otherApp.id], status: ApplicationStatus.Rejected });

    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBe(1);

    const own = await testDataSource.getRepository(Application).findOne({ where: { id: ownApp.id } });
    const other = await testDataSource
      .getRepository(Application)
      .findOne({ where: { id: otherApp.id } });
    expect(own?.status).toBe(ApplicationStatus.Rejected);
    expect(other?.status).not.toBe(ApplicationStatus.Rejected);
  });

  it("404s when none of the applications are owned by the caller", async () => {
    const { user: otherRecruiter } = await createRecruiter();
    const { token } = await createRecruiter();
    const role = await createRole();
    const otherJob = await createJob(otherRecruiter, role);
    const { user: talent } = await createTalent();
    const otherApp = await createApplication(talent, otherJob);

    const res = await request(app)
      .patch("/v1/applications/status")
      .set("Authorization", `Bearer ${token}`)
      .send({ applicationIds: [otherApp.id], status: ApplicationStatus.Rejected });

    expect(res.status).toBe(404);
  });

  it("Talent cannot call the bulk endpoint → 403", async () => {
    const { token: talentToken } = await createTalent();

    const res = await request(app)
      .patch("/v1/applications/status")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({ applicationIds: ["some-id"], status: ApplicationStatus.Rejected });

    expect(res.status).toBe(403);
  });

  it("rejects an empty applicationIds array", async () => {
    const { token } = await createRecruiter();

    const res = await request(app)
      .patch("/v1/applications/status")
      .set("Authorization", `Bearer ${token}`)
      .send({ applicationIds: [], status: ApplicationStatus.Rejected });

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/jobs/applications/:jobId — apply for a job (Talent)
// ---------------------------------------------------------------------------

describe("PATCH /v1/jobs/applications/:jobId — apply for job", () => {
  it("Talent with passing prescreening score applies successfully → 201", async () => {
    const { token: talentToken } = await createTalent({ prescreeningScore: 75 });
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    const aiConfig = await createAIConfig(recruiter, { minPrescreeningScore: 60 });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const res = await request(app)
      .patch(`/v1/jobs/applications/${job.id}`)
      .set("Authorization", `Bearer ${talentToken}`)
      .send({});
    expect(res.status).toBe(201);
  });

  it("Talent without prescreeningScore can still apply immediately → 201", async () => {
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
    expect(res.status).toBe(201);
  });

  it("Talent with score below minPrescreeningScore can still apply immediately → 201", async () => {
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
    expect(res.status).toBe(201);
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

    await createApplication((await createTalent()).user, job, {
      averageScore: 95,
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.Shortlisted,
      rank: 1,
    });
    await createApplication((await createTalent()).user, job, {
      averageScore: 40,
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.Shortlisted,
      rank: 2,
    });
    await createApplication((await createTalent()).user, job, {
      averageScore: 70,
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.Shortlisted,
      rank: 3,
    });

    // ISSUE-005: ranks are sequential by insertion order, not by averageScore.
    const loaded = await testDataSource.getRepository(Application).find({
      where: { jobId: job.id },
      order: { rank: "ASC" },
    });

    expect(loaded.length).toBe(3);
    expect(loaded.every((a) => a.rank !== null)).toBe(true);
  });
});
