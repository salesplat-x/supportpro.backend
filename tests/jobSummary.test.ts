import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import {
  createAIConfig,
  createApplication,
  createJob,
  createOrganization,
  createRecruiter,
  createRole,
  createTalent,
} from "./helpers/fixtures.js";
import { ApplicationStatus } from "../src/types/enums.js";
import { AiInterview } from "../src/entities/AiInterview.js";
import { AiInterviewQuestion } from "../src/entities/AiInterviewQuestion.js";
import type { Application } from "../src/entities/Application.js";
import type { Job } from "../src/entities/Job.js";

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

const get = (path: string, token: string) =>
  request(app).get(path).set("Authorization", `Bearer ${token}`);

const setup = async () => {
  const { user: recruiter, token } = await createRecruiter({
    firstName: "Philip",
    lastName: "Kosana",
  });
  const org = await createOrganization(recruiter, { name: "Kosana Tech" });
  await testDataSource.query(
    `INSERT INTO organization_members (user_id, organization_id, work_email, role) VALUES ($1, $2, $3, 'owner')`,
    [recruiter.id, org.id, recruiter.email]
  );
  const config = await createAIConfig(recruiter, { minPrescreeningScore: 60, aiInterview: true });
  const role = await createRole("Growth Marketing Manager");
  const job = await createJob(recruiter, role, {
    organizationId: org.id,
    aiConfigId: config.id,
    skills: ["Paid Social", "GA4"],
  });
  return { recruiter, token, org, job };
};

const applicant = async (
  job: Job,
  overrides: Partial<Application> = {},
  user: { prescreeningScore?: number | null; cvSkills?: string[] | null; firstName?: string } = {}
) => {
  const { user: talent } = await createTalent({
    prescreeningScore: user.prescreeningScore ?? null,
    firstName: user.firstName ?? "Test",
  });
  if (user.cvSkills) {
    await testDataSource.query(`UPDATE users SET cv_skills = $2::jsonb WHERE id = $1`, [
      talent.id,
      JSON.stringify(user.cvSkills),
    ]);
  }
  return createApplication(talent, job, overrides);
};

const interviewFor = async (
  application: Application,
  options: { invited?: boolean; recorded: number; questions: number; scored?: boolean }
) => {
  const interview = await testDataSource.getRepository(AiInterview).save({
    applicationId: application.id,
    jobId: application.jobId,
    talentId: application.talentId,
    mode: "audio_video",
    status: options.invited ? "invited" : "ready",
    invitedAt: options.invited ? new Date() : null,
    scoringStatus: options.scored ? "completed" : null,
  });
  for (let i = 0; i < options.questions; i++) {
    await testDataSource.getRepository(AiInterviewQuestion).save({
      interviewId: interview.id,
      position: i + 1,
      question: `Question ${i + 1}`,
      recordedAt: i < options.recorded ? new Date() : null,
    });
  }
  return interview;
};

describe("GET /v1/jobs/applications/:jobId progress fields", () => {
  it("puts each application in one board column and leaves rejected ones off the board", async () => {
    const { token, job } = await setup();
    const applied = await applicant(job);
    const cv = await applicant(job, { cvSimilarityScore: 80 });
    const pre = await applicant(job, { cvSimilarityScore: 80 }, { prescreeningScore: 70 });
    const personality = await applicant(job, { mbtiType: "ENFJ" }, { prescreeningScore: 70 });
    const shortlisted = await applicant(job, { status: ApplicationStatus.Shortlisted });
    const rejected = await applicant(job, {
      status: ApplicationStatus.Rejected,
      cvSimilarityScore: 90,
    });

    const res = await get(`/v1/jobs/applications/${job.id}?limit=50`, token);

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(6);
    const byId = Object.fromEntries(
      res.body.data.applications.map((a: { id: string; boardColumn: string | null }) => [
        a.id,
        a.boardColumn,
      ])
    );
    expect(byId).toEqual({
      [applied.id]: "applied",
      [cv.id]: "cv_matched",
      [pre.id]: "pre_screened",
      [personality.id]: "personality_test",
      [shortlisted.id]: "shortlisted",
      [rejected.id]: null,
    });

    const column = await get(`/v1/jobs/applications/${job.id}?boardColumn=cv_matched`, token);
    expect(column.body.data.applications.map((a: { id: string }) => a.id)).toEqual([cv.id]);
    expect(column.body.data.total).toBe(1);
  });

  it("works out the interview status from the recordings and the scoring", async () => {
    const { token, job } = await setup();
    const none = await applicant(job);
    const notInvited = await applicant(job);
    const started = await applicant(job);
    const processing = await applicant(job);
    const ready = await applicant(job);
    await interviewFor(notInvited, { recorded: 0, questions: 5 });
    await interviewFor(started, { invited: true, recorded: 2, questions: 5 });
    await interviewFor(processing, { invited: true, recorded: 6, questions: 6 });
    const readyInterview = await interviewFor(ready, {
      invited: true,
      recorded: 5,
      questions: 5,
      scored: true,
    });

    const res = await get(`/v1/jobs/applications/${job.id}`, token);

    const byId = Object.fromEntries(
      res.body.data.applications.map(
        (a: { id: string; interview: { id: string | null; status: string } }) => [
          a.id,
          a.interview.status,
        ]
      )
    );
    expect(byId).toEqual({
      [none.id]: "not_started",
      [notInvited.id]: "not_started",
      [started.id]: "in_progress",
      [processing.id]: "processing",
      [ready.id]: "ready",
    });
    const readyRow = res.body.data.applications.find((a: { id: string }) => a.id === ready.id);
    expect(readyRow.interview.id).toBe(readyInterview.id);
    expect(readyRow.stage).toBe("interview");

    const filtered = await get(`/v1/jobs/applications/${job.id}?interview=processing`, token);
    expect(filtered.body.data.applications.map((a: { id: string }) => a.id)).toEqual([
      processing.id,
    ]);
  });

  it("searches applicants by name and pages with a total", async () => {
    const { token, job } = await setup();
    await applicant(job, {}, { firstName: "Amaka" });
    await applicant(job, {}, { firstName: "Tunde" });
    await applicant(job, {}, { firstName: "Zainab" });

    const search = await get(`/v1/jobs/applications/${job.id}?q=amak`, token);
    expect(search.body.data.applications).toHaveLength(1);
    expect(search.body.data.total).toBe(1);

    const page = await get(`/v1/jobs/applications/${job.id}?limit=2&offset=2`, token);
    expect(page.body.data.applications).toHaveLength(1);
    expect(page.body.data.total).toBe(3);
  });

  it("rejects an unknown board column", async () => {
    const { token, job } = await setup();
    const res = await get(`/v1/jobs/applications/${job.id}?boardColumn=interview`, token);
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/jobs/:jobId/summary", () => {
  it("returns the job's numbers, pipeline and board counts", async () => {
    const { token, job } = await setup();
    await applicant(
      job,
      { cvSimilarityScore: 90 },
      { prescreeningScore: 80, cvSkills: ["paid social"] }
    );
    await applicant(job, { cvSimilarityScore: 70 }, { prescreeningScore: 40, cvSkills: ["GA4"] });
    await applicant(job, { status: ApplicationStatus.Shortlisted, mbtiType: "ENFJ" });
    const interviewed = await applicant(job, { cvSimilarityScore: 80 });
    await interviewFor(interviewed, { invited: true, recorded: 0, questions: 5 });

    const res = await get(`/v1/jobs/${job.id}/summary`, token);

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.applicants).toEqual({ total: 4, thisWeek: 4 });
    expect(data.passRate).toMatchObject({ value: 50, passed: 1, preScreened: 2 });
    expect(data.avgCvMatch.value).toBe(80);
    expect(data.shortlisted).toEqual({ count: 1, pctOfApplicants: 25 });
    expect(data.pipeline).toEqual({
      applied: 4,
      cvMatched: 3,
      preScreened: 2,
      personalityTest: 1,
      interview: 1,
    });
    expect(data.topSkills).toEqual([
      { skill: "Paid Social", pct: 25 },
      { skill: "GA4", pct: 25 },
    ]);
    expect(data.hiringTeam).toEqual([
      expect.objectContaining({ name: "Philip Kosana", role: "owner", isOwner: true }),
    ]);
    expect(data.keyDates.postedBy).toBe("Philip Kosana");
    expect(data.keyDates.interviewsStartAt).not.toBeNull();
    expect(data.recentActivity.map((item: { type: string }) => item.type)).toEqual(
      expect.arrayContaining(["shortlisted", "interview_invited", "matched"])
    );
  });

  it("compares the pass rate with the company's previous job", async () => {
    const { recruiter, token, org, job } = await setup();
    const role = await createRole("Earlier Role");
    const earlier = await createJob(recruiter, role, {
      organizationId: org.id,
      aiConfigId: job.aiConfigId,
    });
    await testDataSource.query(
      `UPDATE jobs SET "createdAt" = NOW() - INTERVAL '30 days' WHERE id = $1`,
      [earlier.id]
    );
    await applicant(earlier, {}, { prescreeningScore: 90 });
    await applicant(earlier, {}, { prescreeningScore: 10 });
    await applicant(earlier, {}, { prescreeningScore: 10 });
    await applicant(earlier, {}, { prescreeningScore: 10 });
    await applicant(job, {}, { prescreeningScore: 90 });
    await applicant(job, {}, { prescreeningScore: 10 });

    const res = await get(`/v1/jobs/${job.id}/summary`, token);

    expect(res.body.data.passRate.value).toBe(50);
    expect(res.body.data.passRate.deltaVsLastPost).toBe(25);
  });

  it("refuses another company's job", async () => {
    const { job } = await setup();
    const { token: otherToken } = await createRecruiter();
    const res = await get(`/v1/jobs/${job.id}/summary`, otherToken);
    expect(res.status).toBe(403);
  });
});
