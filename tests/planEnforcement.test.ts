/**
 * Plan enforcement over HTTP — each gated feature is refused or allowed according to the
 * organization's current plan, and a plan change swaps the feature set rather than mixing it.
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
  createApplication,
  createJob,
  createOrganization,
  createRecruiter,
  createRole,
  createTalent,
} from "./helpers/fixtures.js";
import { currentPeriodStart, setOrganizationBilling } from "../src/services/billingState.js";
import { Application } from "../src/entities/Application.js";
import { FeatureUsageCounter } from "../src/entities/FeatureUsageCounter.js";
import { Message } from "../src/entities/Message.js";
import { Organization } from "../src/entities/Organization.js";
import { User } from "../src/entities/User.js";
import {
  ApplicationStatus,
  BillingInterval,
  BillingStatus,
  DEFAULT_BILLING_PLAN_KEY,
  PlanChangeReason,
} from "../src/types/enums.js";

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
});

const inAMonth = () => new Date(Date.now() + 30 * 24 * 3600 * 1000);

async function recruiterOnPlan(
  billingPlan: string
): Promise<{ user: User; token: string; org: Organization }> {
  const { user, token } = await createRecruiter();
  const paid = billingPlan !== DEFAULT_BILLING_PLAN_KEY;
  const org = await createOrganization(user, {
    billingPlan,
    billingInterval: paid ? BillingInterval.Monthly : null,
    billingStatus: BillingStatus.Active,
    billingPeriodEnd: paid ? inAMonth() : null,
  });
  return { user, token, org };
}

async function switchPlan(orgId: string, billingPlan: string): Promise<void> {
  await setOrganizationBilling(
    orgId,
    {
      billingPlan,
      billingInterval: BillingInterval.Monthly,
      billingStatus: BillingStatus.Active,
      billingPeriodEnd: inAMonth(),
    },
    { reason: PlanChangeReason.Purchase }
  );
}

async function seedViews(orgId: string, count: number): Promise<void> {
  await testDataSource.getRepository(FeatureUsageCounter).save({
    organizationId: orgId,
    featureKey: "candidate_views",
    periodStart: currentPeriodStart(),
    count,
  });
}

async function viewsUsed(orgId: string): Promise<number> {
  const row = await testDataSource.getRepository(FeatureUsageCounter).findOne({
    where: { organizationId: orgId, featureKey: "candidate_views" },
  });
  return row?.count ?? 0;
}

async function talentWithCv(): Promise<User> {
  const { user } = await createTalent({ cvUrl: "https://cdn.example.com/cvs/talent.pdf" });
  return user;
}

async function jobWithApplicants(recruiter: User, org: Organization) {
  const role = await createRole();
  const job = await createJob(recruiter, role, { organizationId: org.id });
  const { user: talentA } = await createTalent();
  const { user: talentB } = await createTalent();
  const appA = await createApplication(talentA, job);
  const appB = await createApplication(talentB, job);
  return { job, appA, appB };
}

describe("candidate_views — monthly CV views", () => {
  it("allows a view under the limit and counts it", async () => {
    const { token, org } = await recruiterOnPlan("sme_basic");
    await seedViews(org.id, 49);
    const talent = await talentWithCv();

    const res = await request(app)
      .get(`/v1/user/profile/${talent.id}/cv`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(302);
    expect(await viewsUsed(org.id)).toBe(50);
  });

  it.each([
    ["pay_per_use", 25],
    ["sme_basic", 50],
    ["pro", 250],
  ])("%s refuses the view once its %i views are used", async (plan, limit) => {
    const { token, org } = await recruiterOnPlan(plan);
    await seedViews(org.id, limit);
    const talent = await talentWithCv();

    const res = await request(app)
      .get(`/v1/user/profile/${talent.id}/cv`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe("PLAN_LIMIT_REACHED");
    expect(res.body.error.featureKey).toBe("candidate_views");
    expect(res.body.error.planKey).toBe(plan);
    expect(await viewsUsed(org.id)).toBe(limit);
  });

  it("an unlimited plan is never refused", async () => {
    const { token, org } = await recruiterOnPlan("advance");
    await seedViews(org.id, 100_000);
    const talent = await talentWithCv();

    const res = await request(app)
      .get(`/v1/user/profile/${talent.id}/cv`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(302);
  });
});

describe("bulk_broadcast_tools — bulk pipeline actions", () => {
  it.each(["pay_per_use", "sme_basic"])(
    "%s cannot bulk-update applications and nothing changes",
    async (plan) => {
      const { user, token, org } = await recruiterOnPlan(plan);
      const { appA, appB } = await jobWithApplicants(user, org);

      const res = await request(app)
        .patch("/v1/applications/status")
        .set("Authorization", `Bearer ${token}`)
        .send({ applicationIds: [appA.id, appB.id], status: ApplicationStatus.Rejected });

      expect(res.status).toBe(402);
      expect(res.body.error.featureKey).toBe("bulk_broadcast_tools");
      const statuses = await testDataSource
        .getRepository(Application)
        .find({ select: { status: true } });
      expect(statuses.every((a) => a.status === ApplicationStatus.Pending)).toBe(true);
    }
  );

  it.each(["pro", "advance", "enterprise"])("%s can bulk-update applications", async (plan) => {
    const { user, token, org } = await recruiterOnPlan(plan);
    const { appA, appB } = await jobWithApplicants(user, org);

    const res = await request(app)
      .patch("/v1/applications/status")
      .set("Authorization", `Bearer ${token}`)
      .send({ applicationIds: [appA.id, appB.id], status: ApplicationStatus.Rejected });

    expect(res.status).toBe(200);
  });
});

describe("bulk_broadcast_tools — broadcast messaging", () => {
  it("sme_basic cannot broadcast and no message is sent", async () => {
    const { user, token, org } = await recruiterOnPlan("sme_basic");
    const { appA } = await jobWithApplicants(user, org);

    const res = await request(app)
      .post("/v1/messages/broadcast")
      .set("Authorization", `Bearer ${token}`)
      .send({ application: appA.id, content: "Hello everyone" });

    expect(res.status).toBe(402);
    expect(await testDataSource.getRepository(Message).count()).toBe(0);
  });

  it("pro can broadcast to every applicant", async () => {
    const { user, token, org } = await recruiterOnPlan("pro");
    const { appA } = await jobWithApplicants(user, org);

    const res = await request(app)
      .post("/v1/messages/broadcast")
      .set("Authorization", `Bearer ${token}`)
      .send({ application: appA.id, content: "Hello everyone" });

    expect(res.status).toBe(200);
    expect(await testDataSource.getRepository(Message).count()).toBe(2);
  });
});

describe("switching plans swaps the feature set", () => {
  it("pro → sme_basic loses bulk tools straight away", async () => {
    const { user, token, org } = await recruiterOnPlan("pro");
    const { appA, appB } = await jobWithApplicants(user, org);
    await switchPlan(org.id, "sme_basic");

    const res = await request(app)
      .patch("/v1/applications/status")
      .set("Authorization", `Bearer ${token}`)
      .send({ applicationIds: [appA.id, appB.id], status: ApplicationStatus.Shortlisted });

    expect(res.status).toBe(402);
    expect(res.body.error.planKey).toBe("sme_basic");
  });

  it("sme_basic → pro gains bulk tools straight away", async () => {
    const { user, token, org } = await recruiterOnPlan("sme_basic");
    const { appA } = await jobWithApplicants(user, org);
    await switchPlan(org.id, "pro");

    const res = await request(app)
      .post("/v1/messages/broadcast")
      .set("Authorization", `Bearer ${token}`)
      .send({ application: appA.id, content: "Hello everyone" });

    expect(res.status).toBe(200);
  });

  it("an expired pro plan no longer grants bulk tools", async () => {
    const { user, token, org } = await recruiterOnPlan("pro");
    const { appA } = await jobWithApplicants(user, org);
    await testDataSource
      .getRepository(Organization)
      .update(org.id, { billingPeriodEnd: new Date(Date.now() - 3600_000) });

    const res = await request(app)
      .post("/v1/messages/broadcast")
      .set("Authorization", `Bearer ${token}`)
      .send({ application: appA.id, content: "Hello everyone" });

    expect(res.status).toBe(402);
    expect(res.body.error.planKey).toBe(DEFAULT_BILLING_PLAN_KEY);
  });

  it("views used under the old plan do not count against the new one", async () => {
    const { token, org } = await recruiterOnPlan("sme_basic");
    await seedViews(org.id, 50);
    const talent = await talentWithCv();

    const blocked = await request(app)
      .get(`/v1/user/profile/${talent.id}/cv`)
      .set("Authorization", `Bearer ${token}`);
    expect(blocked.status).toBe(402);

    await switchPlan(org.id, "pro");

    const allowed = await request(app)
      .get(`/v1/user/profile/${talent.id}/cv`)
      .set("Authorization", `Bearer ${token}`);
    expect(allowed.status).toBe(302);
    expect(await viewsUsed(org.id)).toBe(1);
  });

  it("a downgrade does not inherit the old plan's views either", async () => {
    const { token, org } = await recruiterOnPlan("pro");
    await seedViews(org.id, 200);
    const talent = await talentWithCv();
    await switchPlan(org.id, "sme_basic");

    const res = await request(app)
      .get(`/v1/user/profile/${talent.id}/cv`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(302);
    expect(await viewsUsed(org.id)).toBe(1);
  });
});
