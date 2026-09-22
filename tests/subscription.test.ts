/**
 * Subscription admin-gating tests — src/routes/subscription.ts.
 *
 * Subscriptions carry another organization's billing state and have no ownership
 * scoping anywhere in services/subscription.ts (fetchAll returns every org's rows,
 * enable/disable take a bare :id with no owner check). These routes are Admin-only —
 * see the regression coverage below for what used to be a cross-tenant data leak /
 * sabotage vector (any verified user could list, view, enable or disable ANY
 * organization's subscription).
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
  createOrganization,
  createPlan,
  createSubscription,
} from "./helpers/fixtures.js";
import { Subscription } from "../src/entities/Subscription.js";
import { BillingInterval, Currency, SubscriptionStatus } from "../src/types/enums.js";

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

async function seedSubscription(): Promise<{ sub: Subscription; orgId: string; ownerId: string }> {
  const { user: owner } = await createRecruiter();
  const org = await createOrganization(owner);
  const plan = await createPlan({
    planKey: "pro",
    interval: BillingInterval.Monthly,
    currency: Currency.NGN,
  });
  const sub = await createSubscription(owner, plan, {
    organizationId: org.id,
    status: SubscriptionStatus.Active,
  });
  return { sub, orgId: org.id, ownerId: owner.id };
}

describe("GET /v1/subscriptions — list all (Admin only)", () => {
  it("Admin can list every organization's subscriptions", async () => {
    await seedSubscription();
    const { token } = await createAdmin();
    const res = await request(app).get("/v1/subscriptions").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.subs.length).toBeGreaterThanOrEqual(1);
  });

  it("Recruiter cannot list subscriptions → 403 (was previously wide open to any verified user)", async () => {
    await seedSubscription();
    const { token } = await createRecruiter();
    const res = await request(app).get("/v1/subscriptions").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("Talent cannot list subscriptions → 403", async () => {
    await seedSubscription();
    const { token } = await createTalent();
    const res = await request(app).get("/v1/subscriptions").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app).get("/v1/subscriptions");
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/subscriptions/:id — fetch one (Admin only)", () => {
  it("Admin can fetch any organization's subscription by id", async () => {
    const { sub } = await seedSubscription();
    const { token } = await createAdmin();
    const res = await request(app)
      .get(`/v1/subscriptions/${sub.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.sub.id).toBe(sub.id);
  });

  it("Non-existent id → 404", async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .get("/v1/subscriptions/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("A recruiter with no relationship to the subscription cannot view it → 403", async () => {
    const { sub } = await seedSubscription();
    const { token } = await createRecruiter();
    const res = await request(app)
      .get(`/v1/subscriptions/${sub.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe("POST /v1/subscriptions — fetch by match (Admin only)", () => {
  it("Admin can look up a subscription by userId", async () => {
    const { sub, ownerId } = await seedSubscription();
    const { token } = await createAdmin();
    const res = await request(app)
      .post("/v1/subscriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: ownerId });
    expect(res.status).toBe(200);
    expect(res.body.data.sub.id).toBe(sub.id);
  });

  it("Admin can look up a subscription by planId", async () => {
    const { sub } = await seedSubscription();
    const { token } = await createAdmin();
    const res = await request(app)
      .post("/v1/subscriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({ planId: sub.planId });
    expect(res.status).toBe(200);
  });

  it("Neither userId nor planId provided → 400 (not an unfiltered lookup)", async () => {
    await seedSubscription();
    const { token } = await createAdmin();
    const res = await request(app)
      .post("/v1/subscriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("Sending the old mismatched field names ('user'/'plan') is now rejected instead of silently ignored", async () => {
    await seedSubscription();
    const { token } = await createAdmin();
    // Regression guard: the validator used to check body.user/body.plan while the
    // service read body.userId/body.planId — a client sending {user: "x"} would pass
    // validation but the service would build a WHERE-less query and return an
    // arbitrary row. Now the validator and service agree on field names, so this
    // is correctly rejected as "neither provided".
    const res = await request(app)
      .post("/v1/subscriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({ user: "irrelevant-value" });
    expect(res.status).toBe(400);
  });

  it("Recruiter cannot look up subscriptions → 403", async () => {
    const { ownerId } = await seedSubscription();
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/subscriptions")
      .set("Authorization", `Bearer ${token}`)
      .send({ userId: ownerId });
    expect(res.status).toBe(403);
  });
});

describe("GET /v1/subscriptions/enable|disable/:id (Admin only)", () => {
  it("Admin can disable another organization's active subscription", async () => {
    const { sub } = await seedSubscription();
    const { token } = await createAdmin();
    const res = await request(app)
      .get(`/v1/subscriptions/disable/${sub.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const updated = await testDataSource
      .getRepository(Subscription)
      .findOne({ where: { id: sub.id } });
    expect(updated?.status).toBe(SubscriptionStatus.Cancelled);
  });

  it("Admin can re-enable a disabled subscription", async () => {
    const { sub } = await seedSubscription();
    await testDataSource
      .getRepository(Subscription)
      .update(sub.id, { status: SubscriptionStatus.Cancelled });
    const { token } = await createAdmin();
    const res = await request(app)
      .get(`/v1/subscriptions/enable/${sub.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const updated = await testDataSource
      .getRepository(Subscription)
      .findOne({ where: { id: sub.id } });
    expect(updated?.status).toBe(SubscriptionStatus.Active);
  });

  it("Disabling an already-cancelled subscription is idempotent", async () => {
    const { sub } = await seedSubscription();
    await testDataSource
      .getRepository(Subscription)
      .update(sub.id, { status: SubscriptionStatus.Cancelled });
    const { token } = await createAdmin();
    const res = await request(app)
      .get(`/v1/subscriptions/disable/${sub.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("Non-existent id → 404", async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .get("/v1/subscriptions/disable/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("Recruiter cannot disable a subscription (would have let anyone cancel any company's billing) → 403", async () => {
    const { sub } = await seedSubscription();
    const { token } = await createRecruiter();
    const res = await request(app)
      .get(`/v1/subscriptions/disable/${sub.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    const untouched = await testDataSource
      .getRepository(Subscription)
      .findOne({ where: { id: sub.id } });
    expect(untouched?.status).toBe(SubscriptionStatus.Active);
  });

  it("Talent cannot enable a subscription → 403", async () => {
    const { sub } = await seedSubscription();
    await testDataSource
      .getRepository(Subscription)
      .update(sub.id, { status: SubscriptionStatus.Cancelled });
    const { token } = await createTalent();
    const res = await request(app)
      .get(`/v1/subscriptions/enable/${sub.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("Unauthenticated → 401", async () => {
    const { sub } = await seedSubscription();
    const res = await request(app).get(`/v1/subscriptions/disable/${sub.id}`);
    expect(res.status).toBe(401);
  });
});
