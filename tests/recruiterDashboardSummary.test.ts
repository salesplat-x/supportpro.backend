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
  createOrganization,
  createRole,
  createJob,
  createApplication,
  createTalent,
} from "./helpers/fixtures.js";
import {
  ApplicationStatus,
  ApplicationType,
  JobStatus,
  MatchVerdictStatus,
  ScreeningStage,
} from "../src/types/enums.js";
import type { Application } from "../src/entities/Application.js";

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

const DAY_MS = 24 * 60 * 60 * 1000;
const todayUtc = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};
const key = (date: Date) => date.toISOString().slice(0, 10);

const setCreatedAt = (table: "applications" | "jobs", id: string, value: string) =>
  testDataSource.query(`UPDATE ${table} SET "createdAt" = $2::timestamp WHERE id = $1`, [
    id,
    value,
  ]);

const get = (path: string, token: string) =>
  request(app).get(path).set("Authorization", `Bearer ${token}`);

const setup = async () => {
  const { user: recruiter, token } = await createRecruiter();
  const org = await createOrganization(recruiter, { name: "Kosana Tech" });
  const role = await createRole("Product Designer");
  const job = await createJob(recruiter, role, { organizationId: org.id });
  return { recruiter, token, org, role, job };
};

const applicant = async (overrides: { prescreeningScore?: number | null } = {}) =>
  (await createTalent({ prescreeningScore: overrides.prescreeningScore ?? null })).user;

describe("GET /v1/recruiter/dashboard/summary", () => {
  it("returns zeros and a zero-filled series when the recruiter has no company", async () => {
    const { token } = await createRecruiter();

    const res = await get("/v1/recruiter/dashboard/summary?chart=12w", token);

    expect(res.status).toBe(200);
    expect(res.body.data.kpis.applications).toEqual({ total: 0, current: 0, previous: 0 });
    expect(res.body.data.series).toHaveLength(12);
    expect(
      res.body.data.series.every((row: { applications: number }) => row.applications === 0)
    ).toBe(true);
    expect(res.body.data.activeJobPosts).toEqual([]);
  });

  it("puts every application on an active job in exactly one status group", async () => {
    const { recruiter, token, job } = await setup();
    const cases: Array<Partial<Application>> = [
      { status: ApplicationStatus.Shortlisted },
      { status: ApplicationStatus.Rejected },
      { status: ApplicationStatus.NotProceeding },
      { status: ApplicationStatus.Pending, currentStage: ScreeningStage.Personality },
      { status: ApplicationStatus.RetakeAssessment, currentStage: ScreeningStage.Personalized },
      { status: ApplicationStatus.AwaitingDecision, currentStage: ScreeningStage.Completed },
      { status: ApplicationStatus.Pending, currentStage: ScreeningStage.Completed },
      { status: ApplicationStatus.RetakeAssessment, currentStage: ScreeningStage.Completed },
    ];
    for (const overrides of cases) {
      await createApplication(await applicant(), job, overrides);
    }
    const role = await createRole("Closed Role");
    const closedJob = await createJob(recruiter, role, {
      organizationId: job.organizationId,
      status: JobStatus.Closed,
    });
    await createApplication(await applicant(), closedJob, {
      status: ApplicationStatus.Shortlisted,
    });

    const res = await get("/v1/recruiter/dashboard/summary", token);

    expect(res.status).toBe(200);
    const status = res.body.data.status;
    expect(status).toEqual({
      total: 8,
      shortlisted: 1,
      rejected: 2,
      inTesting: 2,
      underReview: 3,
    });
    expect(status.shortlisted + status.rejected + status.inTesting + status.underReview).toBe(
      status.total
    );
  });

  it("counts the current and previous period on whole UTC days", async () => {
    const { token, job } = await setup();
    const from = new Date(todayUtc().getTime() - 6 * DAY_MS);
    const previousFrom = new Date(from.getTime() - 7 * DAY_MS);

    const firstOfPeriod = await createApplication(await applicant(), job);
    const lastOfPrevious = await createApplication(await applicant(), job);
    const firstOfPrevious = await createApplication(await applicant(), job);
    const beforePrevious = await createApplication(await applicant(), job);
    await setCreatedAt("applications", firstOfPeriod.id, `${key(from)} 00:00:00`);
    await setCreatedAt(
      "applications",
      lastOfPrevious.id,
      `${key(new Date(from.getTime() - DAY_MS))} 23:59:59`
    );
    await setCreatedAt("applications", firstOfPrevious.id, `${key(previousFrom)} 00:00:00`);
    await setCreatedAt(
      "applications",
      beforePrevious.id,
      `${key(new Date(previousFrom.getTime() - DAY_MS))} 12:00:00`
    );
    await createApplication(await applicant(), job);

    const res = await get("/v1/recruiter/dashboard/summary?range=7", token);

    expect(res.status).toBe(200);
    expect(res.body.data.range).toEqual({ days: 7, from: key(from), to: key(todayUtc()) });
    expect(res.body.data.kpis.applications).toEqual({ total: 5, current: 2, previous: 2 });
    expect(res.body.data.funnel.applied).toBe(2);
  });

  it("builds the funnel from applications in the period, counting each stage on its own", async () => {
    const { token, job } = await setup();
    await createApplication(await applicant({ prescreeningScore: 80 }), job, {
      cvSimilarityScore: 91,
      mbtiType: "INTJ",
      status: ApplicationStatus.Shortlisted,
    });
    await createApplication(await applicant({ prescreeningScore: 60 }), job, {
      mbtiType: "ENFP",
    });
    await createApplication(await applicant(), job, { cvSimilarityScore: 40 });
    const old = await createApplication(await applicant({ prescreeningScore: 90 }), job, {
      cvSimilarityScore: 99,
    });
    await setCreatedAt(
      "applications",
      old.id,
      `${key(new Date(todayUtc().getTime() - 60 * DAY_MS))} 09:00:00`
    );

    const res = await get("/v1/recruiter/dashboard/summary?range=30", token);

    expect(res.body.data.funnel).toEqual({
      applied: 3,
      cvMatched: 2,
      preScreened: 2,
      personalityTest: 2,
      shortlisted: 1,
    });
  });

  it("counts screened applications from a CV score or a finished AI verdict", async () => {
    const { token, job } = await setup();
    await createApplication(await applicant(), job, { cvSimilarityScore: 70 });
    await createApplication(await applicant(), job, {
      matchVerdictStatus: MatchVerdictStatus.Succeeded,
    });
    await createApplication(await applicant(), job, {
      matchVerdictStatus: MatchVerdictStatus.Failed,
    });
    await createApplication(await applicant(), job);

    const res = await get("/v1/recruiter/dashboard/summary?chart=7d", token);

    expect(res.body.data.kpis.screened).toEqual({ total: 2, applications: 4 });
    const series = res.body.data.series as Array<{
      date: string;
      applications: number;
      screened: number;
    }>;
    expect(series).toHaveLength(7);
    expect(series[6]).toEqual({ date: key(todayUtc()), applications: 4, screened: 2 });
    expect(series.slice(0, 6).every((row) => row.applications === 0)).toBe(true);
  });

  it("returns monthly buckets for a year and weekly buckets starting on Monday", async () => {
    const { token } = await setup();

    const year = await get("/v1/recruiter/dashboard/summary?chart=1y", token);
    const weeks = await get("/v1/recruiter/dashboard/summary?chart=12w", token);

    const months = year.body.data.series as Array<{ date: string }>;
    expect(months).toHaveLength(12);
    expect(months.every((row) => row.date.endsWith("-01"))).toBe(true);
    const weekRows = weeks.body.data.series as Array<{ date: string }>;
    expect(weekRows).toHaveLength(12);
    expect(weekRows.every((row) => new Date(`${row.date}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
  });

  it("leaves out invitations and other companies' data", async () => {
    const { token, job } = await setup();
    await createApplication(await applicant(), job);
    await createApplication(await applicant(), job, {
      applicationType: ApplicationType.Invitation,
    });
    const otherOrgOwner = (await createRecruiter()).user;
    const otherOrg = await createOrganization(otherOrgOwner, { name: "Other Co" });
    const otherJob = await createJob(otherOrgOwner, await createRole("Other"), {
      organizationId: otherOrg.id,
    });
    await createApplication(await applicant(), otherJob);

    const res = await get("/v1/recruiter/dashboard/summary", token);

    expect(res.body.data.kpis.applications.total).toBe(1);
    expect(res.body.data.kpis.activeJobs.total).toBe(1);
    expect(res.body.data.activeJobPosts.map((post: { id: string }) => post.id)).toEqual([job.id]);
  });

  it("lists active job posts with applicant and screened counts", async () => {
    const { recruiter, token, job, org } = await setup();
    await createApplication(await applicant(), job, { cvSimilarityScore: 80 });
    await createApplication(await applicant(), job);
    const hybrid = await createJob(recruiter, await createRole("UX Writer"), {
      organizationId: org.id,
      workMode: ["remote", "hybrid"],
    });
    await createJob(recruiter, await createRole("Closed"), {
      organizationId: org.id,
      status: JobStatus.Closed,
    });

    const res = await get("/v1/recruiter/dashboard/summary", token);

    const posts = res.body.data.activeJobPosts as Array<Record<string, unknown>>;
    expect(posts.map((post) => post["id"])).toEqual([hybrid.id, job.id]);
    expect(posts[0]).toMatchObject({
      title: "UX Writer",
      workMode: ["remote", "hybrid"],
      applicants: 0,
    });
    expect(posts[1]).toMatchObject({ title: "Product Designer", applicants: 2, screened: 1 });
    expect(res.body.data.kpis.activeJobs).toEqual({ total: 2, new: 2 });
  });

  it("rejects an unknown range or chart", async () => {
    const { token } = await setup();

    expect((await get("/v1/recruiter/dashboard/summary?range=14", token)).status).toBe(400);
    expect((await get("/v1/recruiter/dashboard/summary?chart=5y", token)).status).toBe(400);
  });

  it("is recruiter-only", async () => {
    const { token } = await createTalent();

    expect((await get("/v1/recruiter/dashboard/summary", token)).status).toBe(403);
    expect((await get("/v1/recruiter/dashboard/applicants", token)).status).toBe(403);
    expect((await get("/v1/recruiter/dashboard/counts", token)).status).toBe(403);
  });
});

describe("GET /v1/recruiter/dashboard/applicants", () => {
  it("pages newest first without repeats when applications share a timestamp", async () => {
    const { token, job } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const created = await createApplication(await applicant({ prescreeningScore: 70 }), job, {
        cvSimilarityScore: 80,
      });
      await setCreatedAt("applications", created.id, `${key(todayUtc())} 10:00:00`);
      ids.push(created.id);
    }

    const first = await get("/v1/recruiter/dashboard/applicants?limit=2&offset=0", token);
    const second = await get("/v1/recruiter/dashboard/applicants?limit=2&offset=2", token);
    const third = await get("/v1/recruiter/dashboard/applicants?limit=2&offset=4", token);

    expect(first.status).toBe(200);
    expect(first.body.data.total).toBe(5);
    const seen = [first, second, third].flatMap((res) =>
      (res.body.data.items as Array<{ id: string }>).map((item) => item.id)
    );
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(ids));
    expect(first.body.data.items[0]).toMatchObject({
      jobId: job.id,
      applicantName: "Test User",
      role: "Product Designer",
      cvMatch: 80,
      prescreeningScore: 70,
      status: ApplicationStatus.Pending,
    });
  });

  it("falls back to a generic name and excludes invitations", async () => {
    const { token, job } = await setup();
    await createApplication((await createTalent({ firstName: "", lastName: "" })).user, job);
    await createApplication(await applicant(), job, {
      applicationType: ApplicationType.Invitation,
    });

    const res = await get("/v1/recruiter/dashboard/applicants", token);

    expect(res.body.data.total).toBe(1);
    expect(res.body.data.items[0].applicantName).toBe("Applicant");
  });

  it("rejects a limit above 50 or a negative offset", async () => {
    const { token } = await setup();

    expect((await get("/v1/recruiter/dashboard/applicants?limit=51", token)).status).toBe(400);
    expect((await get("/v1/recruiter/dashboard/applicants?offset=-1", token)).status).toBe(400);
    expect((await get("/v1/recruiter/dashboard/applicants?limit=0", token)).status).toBe(400);
  });
});

describe("GET /v1/recruiter/dashboard/counts", () => {
  it("counts applications and shortlisted for the active company only", async () => {
    const { token, job } = await setup();
    await createApplication(await applicant(), job, { status: ApplicationStatus.Shortlisted });
    await createApplication(await applicant(), job);
    await createApplication(await applicant(), job, {
      applicationType: ApplicationType.Invitation,
      status: ApplicationStatus.Shortlisted,
    });
    const other = (await createRecruiter()).user;
    const otherOrg = await createOrganization(other);
    const otherJob = await createJob(other, await createRole("Other"), {
      organizationId: otherOrg.id,
    });
    await createApplication(await applicant(), otherJob, { status: ApplicationStatus.Shortlisted });

    const res = await get("/v1/recruiter/dashboard/counts", token);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ applications: 2, shortlisted: 1 });
  });

  it("returns zeros without a company", async () => {
    const { token } = await createRecruiter();

    const res = await get("/v1/recruiter/dashboard/counts", token);

    expect(res.body.data).toEqual({ applications: 0, shortlisted: 0 });
  });
});
