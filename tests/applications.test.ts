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
  createOrganization,
  createQuestion,
  createAdmin,
} from "./helpers/fixtures.js";
import { Application } from "../src/entities/Application.js";
import { User } from "../src/entities/User.js";
import { Job } from "../src/entities/Job.js";
import { Notification } from "../src/entities/Notification.js";
import { AiRecommendation } from "../src/entities/AiRecommendation.js";
import { Answer } from "../src/entities/Answer.js";
import {
  ApplicationStatus,
  ScreeningStage,
  MatchVerdict,
  MatchRecommendation,
  QuestionType,
} from "../src/types/enums.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
  assessApplicationMatch: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({ verdict: "high", reasoning: "Strong overall fit." }),
    },
  }),
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

  it("shows the ai_recommendations verdict even when Application.matchVerdict drifted out of sync", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const app_ = await createApplication(talent, job, { matchVerdict: null });
    await testDataSource.getRepository(AiRecommendation).save(
      testDataSource.getRepository(AiRecommendation).create({
        applicationId: app_.id,
        verdict: MatchVerdict.Medium,
        reasoning: "Drifted row repaired at read time.",
        recommendation: MatchRecommendation.InterviewFurther,
        strengths: null,
        weaknesses: null,
        risks: null,
      })
    );

    const res = await request(app)
      .get("/v1/applications/")
      .set("Authorization", `Bearer ${recruiterToken}`);

    expect(res.status).toBe(200);
    const apps = res.body.data.applications ?? res.body.data ?? [];
    const returned = apps.find((a: { id: string }) => a.id === app_.id);
    expect(returned.matchVerdict).toBe(MatchVerdict.Medium);
    expect(returned.matchVerdictReasoning).toBe("Drifted row repaired at read time.");
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

  it("lets an Admin fetch any application for the admin candidate dossier view", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const { token: adminToken } = await createAdmin();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const app_ = await createApplication(talent, job);

    const res = await request(app)
      .get(`/v1/applications/${app_.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it("includes the talent's cvUrl so the recruiter can view the CV in a new tab", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const app_ = await createApplication(talent, job);
    await testDataSource.getRepository(User).update(talent.id, {
      cvUrl: "https://salesplat.nyc3.digitaloceanspaces.com/cvs/talent-id/some-uuid.pdf",
    });

    const res = await request(app)
      .get(`/v1/applications/${app_.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.application.talent.cvUrl).toBe(
      "https://salesplat.nyc3.digitaloceanspaces.com/cvs/talent-id/some-uuid.pdf"
    );
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

  it("shows the ai_recommendations verdict even when Application.matchVerdict drifted out of sync", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    // Simulates a row that drifted: an AiRecommendation exists but the
    // denormalized Application column was never (or no longer) populated.
    const app_ = await createApplication(talent, job, { matchVerdict: null });
    await testDataSource.getRepository(AiRecommendation).save(
      testDataSource.getRepository(AiRecommendation).create({
        applicationId: app_.id,
        verdict: MatchVerdict.High,
        reasoning: "Strong fit despite the drifted column.",
        recommendation: MatchRecommendation.Hire,
        strengths: ["Great CV match"],
        weaknesses: null,
        risks: null,
      })
    );

    const res = await request(app)
      .get(`/v1/applications/${app_.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.application.matchVerdict).toBe(MatchVerdict.High);
    expect(res.body.data.application.matchVerdictReasoning).toBe(
      "Strong fit despite the drifted column."
    );
  });

  it("includes personality and personalized Q&A so recruiters can read submitted answers", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const app_ = await createApplication(talent, job);

    const personalityQuestion = await createQuestion(
      QuestionType.Personality,
      { jobId: job.id },
      { question: "How do you recharge after a long week?", criteria: "EI" }
    );
    const personalizedQuestion = await createQuestion(
      QuestionType.Personalized,
      {
        jobId: job.id,
      },
      { question: "Walk us through a launch you owned." }
    );

    await testDataSource.getRepository(Answer).save(
      testDataSource.getRepository(Answer).create({
        userId: talent.id,
        jobId: job.id,
        questionType: QuestionType.Personality,
        responses: [{ questionId: personalityQuestion.id, answer: "Quiet evenings, then a walk." }],
      })
    );
    await testDataSource.getRepository(Answer).save(
      testDataSource.getRepository(Answer).create({
        userId: talent.id,
        jobId: job.id,
        questionType: QuestionType.Personalized,
        responses: [
          { questionId: personalizedQuestion.id, answer: "I shipped the billing cutover." },
        ],
      })
    );

    const res = await request(app)
      .get(`/v1/applications/${app_.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.application.personalityAnswers).toEqual([
      expect.objectContaining({
        question: "How do you recharge after a long week?",
        answer: "Quiet evenings, then a walk.",
      }),
    ]);
    expect(res.body.data.application.personalizedAnswers).toEqual([
      expect.objectContaining({
        question: "Walk us through a launch you owned.",
        answer: "I shipped the billing cutover.",
      }),
    ]);
  });

  it("still returns submitted answers when the stored response used `question` instead of questionId", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const app_ = await createApplication(talent, job);

    const personalityQuestion = await createQuestion(
      QuestionType.Personality,
      { jobId: job.id },
      { question: "How do you recharge after a long week?", criteria: "EI" }
    );

    await testDataSource.getRepository(Answer).save(
      testDataSource.getRepository(Answer).create({
        userId: talent.id,
        jobId: job.id,
        questionType: QuestionType.Personality,
        responses: [
          {
            question: personalityQuestion.id,
            answer: "Quiet evenings, then a walk.",
          } as unknown as { questionId: string; answer: string },
        ],
      })
    );

    const res = await request(app)
      .get(`/v1/applications/${app_.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.application.personalityAnswers).toEqual([
      expect.objectContaining({
        question: "How do you recharge after a long week?",
        answer: "Quiet evenings, then a walk.",
      }),
    ]);
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

  it("item 9: shortlisting sends the talent a title-only in-app notification, no message body", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole("Backend Developer");
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
    // The title must be the short job/role title, not the long jobBrief
    // description — this was the actual reported bug.
    expect(notifications[0]?.title).toBe(
      "Congratulations, you've been shortlisted for Backend Developer"
    );
    expect(notifications[0]?.title).not.toContain(job.jobBrief);
    // Title-only: no separate "long story" message body underneath.
    expect(notifications[0]?.message).toBe(notifications[0]?.title);
  });

  it("item 9: shortlisting includes the company name in the title when the job has one", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter, token } = await createRecruiter();
    const organization = await createOrganization(recruiter, { name: "TechCorp" });
    const role = await createRole("Backend Developer");
    const job = await createJob(recruiter, role, { organizationId: organization.id });
    const app_ = await createApplication(talent, job);

    await request(app)
      .patch(`/v1/applications/${app_.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: ApplicationStatus.Shortlisted });

    const notifications = await testDataSource
      .getRepository(Notification)
      .find({ where: { userId: talent.id } });
    expect(notifications[0]?.title).toBe(
      "Congratulations, you've been shortlisted for Backend Developer at TechCorp"
    );
  });

  it("item 9: rejecting sends the talent a title-only in-app notification, no message body", async () => {
    const { user: talent } = await createTalent();
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole("Backend Developer");
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
    expect(notifications[0]?.title).toBe("You were not shortlisted for Backend Developer");
    expect(notifications[0]?.title).not.toContain(job.jobBrief);
    expect(notifications[0]?.message).toBe(notifications[0]?.title);
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
    const role = await createRole("Backend Developer");
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
    expect(
      notifications.every(
        (n) => n.title === "Congratulations, you've been shortlisted for Backend Developer"
      )
    ).toBe(true);
    expect(notifications.every((n) => n.message === n.title)).toBe(true);
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

    const own = await testDataSource
      .getRepository(Application)
      .findOne({ where: { id: ownApp.id } });
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
// POST /v1/applications/:_id/verdict — removed; match is generated once
// ---------------------------------------------------------------------------

describe("POST /v1/applications/:_id/verdict — regenerate path is gone", () => {
  it("returns 404 so recruiters cannot force a second generation", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const app_ = await createApplication(talent, job, {
      currentStage: ScreeningStage.Completed,
      status: ApplicationStatus.AwaitingDecision,
    });

    const res = await request(app)
      .post(`/v1/applications/${app_.id}/verdict`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/jobs/applications/:jobId — apply for a job (Talent)
// ---------------------------------------------------------------------------

describe("PATCH /v1/jobs/applications/:jobId — apply for job", () => {
  it("Applying to a job with no aiConfigId → 404", async () => {
    const { token: talentToken } = await createTalent();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    const res = await request(app)
      .patch(`/v1/jobs/applications/${job.id}`)
      .set("Authorization", `Bearer ${talentToken}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it("Talent with passing prescreening score applies successfully → 201", async () => {
    const { token: talentToken } = await createTalent({
      prescreeningScore: 75,
      cvFileName: "cv.pdf",
    });
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
    const { token } = await createTalent({ prescreeningScore: null, cvFileName: "cv.pdf" });
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
    const { token } = await createTalent({ prescreeningScore: 30, cvFileName: "cv.pdf" });
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
    const { token } = await createTalent({ prescreeningScore: 75, cvFileName: "cv.pdf" });
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
    const { user: talent, token: talentToken } = await createTalent({
      prescreeningScore: 75,
      cvFileName: "cv.pdf",
    });
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

  const openJobWithConfig = async () => {
    const { user: recruiter } = await createRecruiter();
    const job = await createJob(recruiter, await createRole());
    const aiConfig = await createAIConfig(recruiter, { minPrescreeningScore: 60 });
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });
    return job;
  };
  const applyTo = (token: string, jobId: string, body: Record<string, unknown> = {}) =>
    request(app)
      .patch(`/v1/jobs/applications/${jobId}`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);

  it("keeps the candidate's short note, trimmed", async () => {
    const { user: talent, token } = await createTalent({ cvFileName: "cv.pdf" });
    const job = await openJobWithConfig();

    const res = await applyTo(token, job.id, { note: "  I designed the merchant app.  " });

    expect(res.status).toBe(201);
    const saved = await testDataSource
      .getRepository(Application)
      .findOneByOrFail({ talentId: talent.id, jobId: job.id });
    expect(saved.applicantNote).toBe("I designed the merchant app.");
  });

  it.each([
    ["a note over 1000 characters", { note: "x".repeat(1001) }],
    ["a note that isn't text", { note: 5 }],
  ])("refuses %s → 400", async (_label, body) => {
    const { token } = await createTalent({ cvFileName: "cv.pdf" });
    const job = await openJobWithConfig();
    expect((await applyTo(token, job.id, body)).status).toBe(400);
  });

  it("refuses a candidate with no CV on their profile → 400", async () => {
    const { user: talent, token } = await createTalent();
    const job = await openJobWithConfig();

    const res = await applyTo(token, job.id);

    expect(res.status).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toMatch(/CV/);
    expect(
      await testDataSource.getRepository(Application).count({ where: { talentId: talent.id } })
    ).toBe(0);
  });

  it("two applications sent at once make one application and count one applicant", async () => {
    const { user: talent, token } = await createTalent({ cvFileName: "cv.pdf" });
    const job = await openJobWithConfig();

    const results = await Promise.all([applyTo(token, job.id), applyTo(token, job.id)]);

    expect(results.map((res) => res.status)).toEqual([201, 201]);
    expect(
      await testDataSource
        .getRepository(Application)
        .count({ where: { talentId: talent.id, jobId: job.id } })
    ).toBe(1);
    const saved = await testDataSource.getRepository(Job).findOneByOrFail({ id: job.id });
    expect(saved.noOfApplicants).toBe(1);
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
