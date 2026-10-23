import request from "supertest";
import { createApp } from "../src/app.js";
import { startTestDatabase, stopTestDatabase, clearAllTables } from "./helpers/db.js";
import { ApplicationStatus, JobStatus, PaymentStatus } from "../src/types/enums.js";
import {
  createAdmin,
  createApplication,
  createErrorLog,
  createJob,
  createPayment,
  createRecruiter,
  createRole,
  createTalent,
} from "./helpers/fixtures.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
}));

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
    sendPasswordReset: jest.fn().mockResolvedValue(undefined),
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
});

const DAY_MS = 24 * 60 * 60 * 1000;

const daysAgo = (days: number): Date => {
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(todayUtc - days * DAY_MS + 12 * 60 * 60 * 1000);
};

const getOverview = (token: string, query = "") =>
  request(app).get(`/v1/admin/overview${query}`).set("Authorization", `Bearer ${token}`);

describe("GET /v1/admin/overview", () => {
  it("rejects unauthenticated, recruiter and talent callers", async () => {
    const { token: recruiterToken } = await createRecruiter();
    const { token: talentToken } = await createTalent();

    expect((await request(app).get("/v1/admin/overview")).status).toBe(401);
    expect((await getOverview(recruiterToken)).status).toBe(403);
    expect((await getOverview(talentToken)).status).toBe(403);
  });

  it("rejects an unsupported range", async () => {
    const { token } = await createAdmin();
    const res = await getOverview(token, "?days=5");
    expect(res.status).toBe(400);
  });

  it("returns zeroed, gap-filled data on an empty platform", async () => {
    const { token } = await createAdmin();
    const res = await getOverview(token);

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.range.days).toBe(30);
    expect(data.kpis.talents).toEqual({ total: 0, new: 0, previous: 0 });
    expect(data.kpis.revenue).toEqual({ total: 0, inRange: 0, previous: 0 });
    expect(data.series.signups).toHaveLength(30);
    expect(data.series.applications).toHaveLength(30);
    expect(data.series.revenue).toHaveLength(30);
    expect(data.series.signups.every((p: { talents: number }) => p.talents === 0)).toBe(true);
  });

  it("sizes the series to the requested range", async () => {
    const { token } = await createAdmin();
    const res = await getOverview(token, "?days=7");
    expect(res.status).toBe(200);
    expect(res.body.data.series.signups).toHaveLength(7);
    expect(res.body.data.range.days).toBe(7);
  });

  it("counts users, deltas and signup series by window", async () => {
    const { token } = await createAdmin();
    await createTalent({ createdAt: daysAgo(0) });
    await createTalent({ createdAt: daysAgo(3) });
    await createTalent({ createdAt: daysAgo(40) });
    await createTalent({ createdAt: daysAgo(200) });
    await createRecruiter({ createdAt: daysAgo(1) });

    const { data } = (await getOverview(token)).body;

    expect(data.kpis.talents).toEqual({ total: 4, new: 2, previous: 1 });
    expect(data.kpis.recruiters.total).toBe(1);
    expect(data.kpis.recruiters.new).toBe(1);

    const signedUpTalents = data.series.signups.reduce(
      (sum: number, point: { talents: number }) => sum + point.talents,
      0
    );
    expect(signedUpTalents).toBe(2);
    expect(data.series.signups.at(-1).date).toBe(data.range.to);
    expect(data.series.signups[0].date).toBe(data.range.from);
  });

  it("breaks applications and jobs down by status", async () => {
    const { token } = await createAdmin();
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const activeJob = await createJob(recruiter, role);
    await createJob(recruiter, role, { status: JobStatus.Closed });
    const { user: talentOne } = await createTalent();
    const { user: talentTwo } = await createTalent();
    await createApplication(talentOne, activeJob, { status: ApplicationStatus.Shortlisted });
    await createApplication(talentTwo, activeJob);

    const { data } = (await getOverview(token)).body;

    expect(data.kpis.jobs).toEqual({ total: 2, active: 1 });
    expect(data.kpis.applications.total).toBe(2);
    expect(data.kpis.applications.new).toBe(2);
    const byStatus = Object.fromEntries(
      data.breakdowns.applicationsByStatus.map((b: { key: string; count: number }) => [
        b.key,
        b.count,
      ])
    );
    expect(byStatus).toEqual({ shortlisted: 1, pending: 1 });
    expect(data.kpis.stuckApplications).toBe(0);
  });

  it("only counts completed NGN payments as revenue", async () => {
    const { token } = await createAdmin();
    const { user } = await createRecruiter();
    await createPayment(user, undefined, {
      amount: 5000,
      status: PaymentStatus.Completed,
      paidAt: daysAgo(0),
    });
    await createPayment(user, undefined, {
      amount: 3000,
      status: PaymentStatus.Pending,
    });
    await createPayment(user, undefined, {
      amount: 90,
      currency: "USD",
      status: PaymentStatus.Completed,
      paidAt: daysAgo(0),
    });
    await createPayment(user, undefined, {
      amount: 2000,
      status: PaymentStatus.Completed,
      paidAt: daysAgo(40),
    });

    const { data } = (await getOverview(token)).body;

    expect(data.kpis.revenue).toEqual({ total: 7000, inRange: 5000, previous: 2000 });
    const seriesTotal = data.series.revenue.reduce(
      (sum: number, point: { amount: number }) => sum + point.amount,
      0
    );
    expect(seriesTotal).toBe(5000);
  });

  it("reports unresolved errors", async () => {
    const { token } = await createAdmin();
    await createErrorLog({ resolved: false });
    await createErrorLog({ resolved: true });

    const { data } = (await getOverview(token)).body;
    expect(data.kpis.unresolvedErrors).toBe(1);
  });

  it("groups talents and recruiters by onboarding stage", async () => {
    const { token } = await createAdmin();
    await createTalent();
    await createRecruiter();

    const { data } = (await getOverview(token)).body;

    const talentTotal = data.breakdowns.talentOnboarding.reduce(
      (sum: number, b: { count: number }) => sum + b.count,
      0
    );
    const recruiterTotal = data.breakdowns.recruiterOnboarding.reduce(
      (sum: number, b: { count: number }) => sum + b.count,
      0
    );
    expect(talentTotal).toBe(1);
    expect(recruiterTotal).toBe(1);
  });
});
