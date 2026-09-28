/**
 * Payment tests — initialization, verification, webhook handling, idempotency.
 */

import { createHmac } from "crypto";
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
  createPayment,
  createOrganization,
  createPlan,
  createSubscription,
  createRole,
  createJob,
  createAIConfig,
} from "./helpers/fixtures.js";
import {
  computeBillingPeriodEnd,
  currentPeriodStart,
  revertToPayPerUseIfExpired,
  setOrganizationBilling,
} from "../src/services/billingState.js";
import {
  ensureOrganizationBillingCurrent,
  getOrganizationUsage,
  recordUsage,
} from "../src/services/entitlements.js";
import { FeatureUsageCounter } from "../src/entities/FeatureUsageCounter.js";
import { Job } from "../src/entities/Job.js";
import { Payment } from "../src/entities/Payment.js";
import { Organization } from "../src/entities/Organization.js";
import { OrganizationMember } from "../src/entities/OrganizationMember.js";
import { Plan } from "../src/entities/Plan.js";
import { OrganizationPlanHistory } from "../src/entities/OrganizationPlanHistory.js";
import * as paystack from "../src/utils/integrations/paystack.js";
import { Subscription } from "../src/entities/Subscription.js";
import { User } from "../src/entities/User.js";
import {
  BillingStatus,
  BillingInterval,
  Currency,
  DEFAULT_BILLING_PLAN_KEY,
  JobStatus,
  PaymentStatus,
  PlanChangeReason,
  SubscriptionStatus,
} from "../src/types/enums.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
    sendPaymentConfirmation: jest.fn().mockResolvedValue(undefined),
  })),
}));

const WEBHOOK_PATH = "/v1/payments/webhook";

const PURCHASED = { reason: PlanChangeReason.Purchase };

const signBody = (body: object): string =>
  createHmac("sha512", process.env.PAYSTACK_SECRET_KEY ?? "")
    .update(JSON.stringify(body))
    .digest("hex");

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

describe("GET /v1/pricing — catalog", () => {
  it("returns the public catalog without auth", async () => {
    const res = await request(app).get("/v1/pricing");
    expect(res.status).toBe(200);
    expect(res.body.data.plans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "sme_basic", monthlyAmountNgn: 150000 }),
        expect.objectContaining({ key: "pro" }),
      ])
    );
  });

  // LOOPHOLE guard: `paid` is a grandfathered legacy tier — explicitly marked
  // `visible: false` in pricing.yaml so it never shows up on the public pricing page.
  // The controller must filter it via publicCatalog(), not just loadPricingCatalog().
  it("Excludes the hidden legacy 'paid' tier from the public catalog", async () => {
    const res = await request(app).get("/v1/pricing");
    const keys = res.body.data.plans.map((p: { key: string }) => p.key);
    expect(keys).not.toContain("paid");
  });
});

// Purchasing a subscription plan requires the recruiter to own an active company (see
// services/payment.ts resolveOrganizationForBilling) and for a matching `Plan` DB row to
// exist for the chosen planKey+interval (synced from pricing.yaml — see services/planSync.ts).
async function createBillableRecruiter(): Promise<{
  token: string;
  user: User;
  orgId: string;
}> {
  const { user, token } = await createRecruiter();
  const org = await createOrganization(user);
  return { token, user, orgId: org.id };
}

describe("POST /v1/payments/ — initialize payment", () => {
  it("Recruiter who owns a company gets a dummy checkout link for a real plan", async () => {
    const { token, orgId } = await createBillableRecruiter();
    await createPlan({
      planKey: "sme_basic",
      interval: BillingInterval.Monthly,
      currency: Currency.NGN,
      paystackAmount: 15_000_000,
    });

    const res = await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${token}`)
      .send({ planKey: "sme_basic", interval: "monthly" });

    expect(res.status).toBe(200);
    expect(res.body.data.link).toContain("/payment/verify");
    expect(res.body.data.mode).toBe("dummy");
    expect(res.body.data.reference).toBeTruthy();

    const payment = await testDataSource
      .getRepository(Payment)
      .findOne({ where: { organizationId: orgId } });
    expect(payment?.status).toBe(PaymentStatus.Pending);
  });

  it("Recruiter with no company → 400 (cannot purchase without a company to bill)", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${token}`)
      .send({ planKey: "sme_basic", interval: "monthly" });
    expect(res.status).toBe(400);
  });

  it("Non-owner member of a company cannot purchase a plan → 403", async () => {
    const { user: owner } = await createRecruiter();
    const org = await createOrganization(owner);
    await createPlan({
      planKey: "sme_basic",
      interval: BillingInterval.Monthly,
      currency: Currency.NGN,
      paystackAmount: 15_000_000,
    });

    const { user: member, token: memberToken } = await createRecruiter();
    await testDataSource.getRepository(User).update(member.id, { activeOrganizationId: org.id });

    const res = await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ planKey: "sme_basic", interval: "monthly" });
    expect(res.status).toBe(403);
  });

  it("Unknown/non-purchasable planKey → 400 (e.g. the hidden 'paid' legacy tier)", async () => {
    const { token } = await createBillableRecruiter();
    const res = await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${token}`)
      .send({ planKey: "paid", interval: "monthly" });
    expect(res.status).toBe(400);
  });

  it("No matching Plan DB row for the requested planKey+interval → 404", async () => {
    const { token } = await createBillableRecruiter();
    // sme_basic exists in the catalogue but was never synced to the `plans` table.
    const res = await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${token}`)
      .send({ planKey: "sme_basic", interval: "monthly" });
    expect(res.status).toBe(404);
  });

  it("Company already on the requested plan → 409", async () => {
    const { token, user, orgId } = await createBillableRecruiter();
    const plan = await createPlan({
      planKey: "sme_basic",
      interval: BillingInterval.Monthly,
      currency: Currency.NGN,
      paystackAmount: 15_000_000,
    });
    await createSubscription(user, plan, {
      organizationId: orgId,
      status: SubscriptionStatus.Active,
    });

    const res = await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${token}`)
      .send({ planKey: "sme_basic", interval: "monthly" });
    expect(res.status).toBe(409);
  });

  it("Switching plans leaves the old subscription active until the new payment completes", async () => {
    const { token, user, orgId } = await createBillableRecruiter();
    const oldPlan = await createPlan({
      planKey: "sme_basic",
      interval: BillingInterval.Monthly,
      currency: Currency.NGN,
      paystackAmount: 15_000_000,
    });
    await createPlan({
      planKey: "pro",
      interval: BillingInterval.Monthly,
      currency: Currency.NGN,
      paystackAmount: 30_000_000,
    });
    const oldSub = await createSubscription(user, oldPlan, {
      organizationId: orgId,
      status: SubscriptionStatus.Active,
    });

    const res = await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${token}`)
      .send({ planKey: "pro", interval: "monthly" });
    expect(res.status).toBe(200);

    // Disabling on initiate used to briefly drop the org to pay per use while checkout
    // was still pending — the swap now happens inside fulfillPayment instead.
    const duringCheckout = await testDataSource
      .getRepository(Subscription)
      .findOne({ where: { id: oldSub.id } });
    expect(duringCheckout?.status).toBe(SubscriptionStatus.Active);

    await request(app)
      .post("/v1/payments/verify")
      .set("Authorization", `Bearer ${token}`)
      .send({ reference: res.body.data.reference })
      .expect(200);

    const afterPayment = await testDataSource
      .getRepository(Subscription)
      .findOne({ where: { id: oldSub.id } });
    expect(afterPayment?.status).toBe(SubscriptionStatus.Cancelled);

    const billed = await testDataSource
      .getRepository(Organization)
      .findOne({ where: { id: orgId } });
    expect(billed!.billingPlan).toBe("pro");
  });

  it("Talent cannot initialize a recruiter payment → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${token}`)
      .send({ planKey: "sme_basic", interval: "monthly" });
    expect(res.status).toBe(403);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app)
      .post("/v1/payments/")
      .send({ planKey: "sme_basic", interval: "monthly" });
    expect(res.status).toBe(401);
  });

  it("Missing planKey → 400", async () => {
    const { token } = await createBillableRecruiter();
    const res = await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${token}`)
      .send({ interval: "monthly" });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/payments/verify", () => {
  it("Rejects unauthenticated verify (ISSUE-002 closed)", async () => {
    const { user } = await createRecruiter();
    const payment = await createPayment(user, undefined, { paystackRef: "PSK_UNAUTHED_TEST" });
    const res = await request(app)
      .post("/v1/payments/verify")
      .send({ reference: payment.paystackRef });
    expect(res.status).toBe(401);
  });

  it("Owner can verify a dummy payment and the company is upgraded to the purchased plan", async () => {
    const { token, user } = await createRecruiter();
    const org = await createOrganization(user);
    const plan = await createPlan({
      planKey: "pro",
      interval: BillingInterval.Monthly,
      currency: Currency.NGN,
      paystackAmount: 30_000_000,
    });
    const payment = await createPayment(user, plan, {
      organizationId: org.id,
      paystackRef: "PSK_VERIFY_TEST",
      reference: "PSK_VERIFY_TEST",
      amountKobo: 30_000_000,
    });

    const res = await request(app)
      .post("/v1/payments/verify")
      .set("Authorization", `Bearer ${token}`)
      .send({ reference: payment.paystackRef });

    expect(res.status).toBe(200);
    const updated = await testDataSource
      .getRepository(Payment)
      .findOne({ where: { id: payment.id } });
    expect(updated!.status).toBe(PaymentStatus.Completed);
    const billed = await testDataSource.getRepository(Organization).findOne({
      where: { id: org.id },
    });
    expect(billed!.billingPlan).toBe("pro");
    expect(billed!.billingStatus).toBe(BillingStatus.Active);
  });

  // The organization's plan is company-wide, not per-verifier — the recruiter who happens
  // to click "verify" doesn't have to be the org owner, only the payment's own creator.
  it("Verifying a payment with no linked organization completes it without touching any billing", async () => {
    const { token, user } = await createRecruiter();
    const payment = await createPayment(user, undefined, {
      paystackRef: "PSK_NO_ORG",
      reference: "PSK_NO_ORG",
    });

    const res = await request(app)
      .post("/v1/payments/verify")
      .set("Authorization", `Bearer ${token}`)
      .send({ reference: payment.paystackRef });

    expect(res.status).toBe(200);
    const updated = await testDataSource
      .getRepository(Payment)
      .findOne({ where: { id: payment.id } });
    expect(updated!.status).toBe(PaymentStatus.Completed);
  });

  it("Another user cannot verify someone else's payment → 403", async () => {
    const { user } = await createRecruiter();
    const { token: otherToken } = await createRecruiter();
    const payment = await createPayment(user, undefined, { paystackRef: "PSK_OTHER" });
    const res = await request(app)
      .post("/v1/payments/verify")
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ reference: payment.paystackRef });
    expect(res.status).toBe(403);
  });

  it("Second verify is idempotent (no error)", async () => {
    const { token, user } = await createRecruiter();
    const payment = await createPayment(user, undefined, {
      paystackRef: "PSK_IDEM_VERIFY",
      status: PaymentStatus.Completed,
    });
    const res = await request(app)
      .post("/v1/payments/verify")
      .set("Authorization", `Bearer ${token}`)
      .send({ reference: payment.paystackRef });
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/payments/webhook", () => {
  it("Valid HMAC + charge.success marks payment completed and upgrades the company's plan", async () => {
    const { user } = await createRecruiter();
    const org = await createOrganization(user);
    const plan = await createPlan({
      planKey: "advance",
      interval: BillingInterval.Monthly,
      currency: Currency.NGN,
      paystackAmount: 50_000_000,
    });
    const payment = await createPayment(user, plan, {
      organizationId: org.id,
      paystackRef: "PSK_WEBHOOK_SUCCESS",
      reference: "PSK_WEBHOOK_SUCCESS",
      amountKobo: 50_000_000,
    });

    const body = {
      event: "charge.success",
      data: {
        id: 1,
        reference: payment.paystackRef,
        status: "success",
        amount: 50_000_000,
        currency: "NGN",
        authorization: { authorization_code: "AUTH_001" },
      },
    };

    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set("x-paystack-signature", signBody(body))
      .send(body);

    expect(res.status).toBe(200);
    const updated = await testDataSource
      .getRepository(Payment)
      .findOne({ where: { id: payment.id } });
    expect(updated!.status).toBe(PaymentStatus.Completed);
    const billed = await testDataSource.getRepository(Organization).findOne({
      where: { id: org.id },
    });
    expect(billed!.billingPlan).toBe("advance");
  });

  it("Webhook for an unknown reference is a no-op, not an error", async () => {
    const body = {
      event: "charge.success",
      data: { id: 5, reference: "PSK_DOES_NOT_EXIST", status: "success", amount: 1 },
    };
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set("x-paystack-signature", signBody(body))
      .send(body);
    expect(res.status).toBe(200);
  });

  it("Invalid HMAC signature → 401", async () => {
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set("x-paystack-signature", "invalid-signature")
      .send({ event: "charge.success", data: { reference: "ANY", status: "success" } });
    expect(res.status).toBe(401);
  });

  it("charge.failed marks payment failed without upgrading the company's plan", async () => {
    const { user } = await createRecruiter();
    const org = await createOrganization(user);
    const payment = await createPayment(user, undefined, {
      organizationId: org.id,
      paystackRef: "PSK_FAIL",
    });
    const body = {
      event: "charge.failed",
      data: { id: 2, reference: payment.paystackRef, status: "failed" },
    };
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set("x-paystack-signature", signBody(body))
      .send(body);
    expect(res.status).toBe(200);
    const updated = await testDataSource
      .getRepository(Payment)
      .findOne({ where: { id: payment.id } });
    expect(updated!.status).toBe(PaymentStatus.Failed);
    const billed = await testDataSource.getRepository(Organization).findOne({
      where: { id: org.id },
    });
    expect(billed!.billingPlan).toBe(DEFAULT_BILLING_PLAN_KEY);
  });

  it("Duplicate webhook is idempotent", async () => {
    const { user } = await createRecruiter();
    const payment = await createPayment(user, undefined, {
      paystackRef: "PSK_WEBHOOK_IDEM",
      reference: "PSK_WEBHOOK_IDEM",
    });
    const body = {
      event: "charge.success",
      data: { id: 9, reference: payment.paystackRef, status: "success", amount: 500000 },
    };
    const sig = signBody(body);
    await request(app).post(WEBHOOK_PATH).set("x-paystack-signature", sig).send(body);
    const res = await request(app).post(WEBHOOK_PATH).set("x-paystack-signature", sig).send(body);
    expect(res.status).toBe(200);
    const rows = await testDataSource.getRepository(Payment).find({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe(PaymentStatus.Completed);
  });

  it("Legacy obfuscated webhook path still works", async () => {
    const { user } = await createRecruiter();
    const payment = await createPayment(user, undefined, { paystackRef: "PSK_LEGACY" });
    const body = {
      event: "charge.success",
      data: { id: 3, reference: payment.paystackRef, status: "success" },
    };
    const res = await request(app)
      .post("/v1/payments/dwhdbwnmdn229dnjkdnn83/webhook")
      .set("x-paystack-signature", signBody(body))
      .send(body);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Billing lifecycle — the org-scoped plan rules end to end: pay_per_use is the default,
// paying migrates the org with a fresh usage period, renewals extend the paid window, and
// expiry/cancellation drops back to pay_per_use (never "free").
// ---------------------------------------------------------------------------

const orgRepo = () => testDataSource.getRepository(Organization);

const reloadOrg = async (orgId: string): Promise<Organization> => {
  const org = await orgRepo().findOne({ where: { id: orgId } });
  if (!org) throw new Error("organization disappeared");
  return org;
};

/** Drives a subscription purchase all the way through in dummy Paystack mode. */
async function buyPlan(
  token: string,
  planKey: string,
  interval: BillingInterval = BillingInterval.Monthly
): Promise<void> {
  const initiated = await request(app)
    .post("/v1/payments/")
    .set("Authorization", `Bearer ${token}`)
    .send({ planKey, interval })
    .expect(200);

  await request(app)
    .post("/v1/payments/verify")
    .set("Authorization", `Bearer ${token}`)
    .send({ reference: initiated.body.data.reference })
    .expect(200);
}

describe("default plan", () => {
  it("a new organization is on pay_per_use with no paid period", async () => {
    const { orgId } = await createBillableRecruiter();
    const org = await reloadOrg(orgId);
    expect(org.billingPlan).toBe(DEFAULT_BILLING_PLAN_KEY);
    expect(org.billingPeriodEnd).toBeNull();
  });

  it("activation defers to PendingPayment, and paying for the job activates it", async () => {
    const { user, token, orgId } = await createBillableRecruiter();
    const role = await createRole();
    const config = await createAIConfig(user);
    const draft = await createJob(user, role, {
      organizationId: orgId,
      status: JobStatus.Draft,
      aiConfigId: config.id,
    });

    const activated = await request(app)
      .patch(`/v1/jobs/${draft.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "active" })
      .expect(200);
    expect(activated.body.data.job.status).toBe("pending_payment");

    const initiated = await request(app)
      .post(`/v1/jobs/${draft.id}/activate-payment`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    await request(app)
      .post("/v1/payments/verify")
      .set("Authorization", `Bearer ${token}`)
      .send({ reference: initiated.body.data.reference })
      .expect(200);

    const paid = await testDataSource.getRepository(Job).findOne({ where: { id: draft.id } });
    expect(paid!.status).toBe(JobStatus.Active);

    // A per-job charge must never move the org off pay per use.
    const org = await reloadOrg(orgId);
    expect(org.billingPlan).toBe(DEFAULT_BILLING_PLAN_KEY);
  });

  describe("paying for a job directly", () => {
    it("a draft job with an AI config can be paid for without going through activation", async () => {
      const { user, token, orgId } = await createBillableRecruiter();
      const role = await createRole();
      const config = await createAIConfig(user);
      const draft = await createJob(user, role, {
        organizationId: orgId,
        status: JobStatus.Draft,
        aiConfigId: config.id,
      });

      const initiated = await request(app)
        .post(`/v1/jobs/${draft.id}/activate-payment`)
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      const verified = await request(app)
        .post("/v1/payments/verify")
        .set("Authorization", `Bearer ${token}`)
        .send({ reference: initiated.body.data.reference })
        .expect(200);
      expect(verified.body.data.jobId).toBe(draft.id);

      const paid = await testDataSource.getRepository(Job).findOne({ where: { id: draft.id } });
      expect(paid!.status).toBe(JobStatus.Active);
    });

    it("a draft job without an AI config cannot be paid for", async () => {
      const { user, token, orgId } = await createBillableRecruiter();
      const role = await createRole();
      const draft = await createJob(user, role, {
        organizationId: orgId,
        status: JobStatus.Draft,
      });

      await request(app)
        .post(`/v1/jobs/${draft.id}/activate-payment`)
        .set("Authorization", `Bearer ${token}`)
        .expect(400);
    });

    it("a closed job cannot be paid for", async () => {
      const { user, token, orgId } = await createBillableRecruiter();
      const role = await createRole();
      const config = await createAIConfig(user);
      const closed = await createJob(user, role, {
        organizationId: orgId,
        status: JobStatus.Closed,
        aiConfigId: config.id,
      });

      await request(app)
        .post(`/v1/jobs/${closed.id}/activate-payment`)
        .set("Authorization", `Bearer ${token}`)
        .expect(400);
    });

    it("an already active job cannot be paid for again", async () => {
      const { user, token, orgId } = await createBillableRecruiter();
      const role = await createRole();
      const config = await createAIConfig(user);
      const active = await createJob(user, role, {
        organizationId: orgId,
        status: JobStatus.Active,
        aiConfigId: config.id,
      });

      await request(app)
        .post(`/v1/jobs/${active.id}/activate-payment`)
        .set("Authorization", `Bearer ${token}`)
        .expect(409);
    });

    it("an organization on a subscription plan cannot pay per job while it still has job slots", async () => {
      const { user, token, orgId } = await createBillableRecruiter();
      const role = await createRole();
      const config = await createAIConfig(user);
      const draft = await createJob(user, role, {
        organizationId: orgId,
        status: JobStatus.Draft,
        aiConfigId: config.id,
      });
      await setOrganizationBilling(
        orgId,
        {
          billingPlan: "pro",
          billingInterval: BillingInterval.Monthly,
          billingStatus: BillingStatus.Active,
          billingPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
        PURCHASED
      );

      await request(app)
        .post(`/v1/jobs/${draft.id}/activate-payment`)
        .set("Authorization", `Bearer ${token}`)
        .expect(400);
    });
  });
});

describe("upgrade", () => {
  beforeEach(async () => {
    await createPlan({
      planKey: "sme_basic",
      interval: BillingInterval.Monthly,
      currency: Currency.NGN,
      paystackAmount: 15_000_000,
    });
    await createPlan({
      planKey: "pro",
      interval: BillingInterval.Monthly,
      currency: Currency.NGN,
      paystackAmount: 30_000_000,
    });
  });

  it("migrates the org immediately and sets a paid period", async () => {
    const { token, orgId } = await createBillableRecruiter();
    await buyPlan(token, "sme_basic");

    const org = await reloadOrg(orgId);
    expect(org.billingPlan).toBe("sme_basic");
    expect(org.billingInterval).toBe(BillingInterval.Monthly);
    expect(org.billingStatus).toBe(BillingStatus.Active);
    expect(org.billingPeriodEnd).toBeInstanceOf(Date);
    expect(org.billingPeriodEnd!.getTime()).toBeGreaterThan(Date.now());
  });

  it("A→B resets monthly meters and reads limits from the new plan", async () => {
    const { token, orgId } = await createBillableRecruiter();
    await buyPlan(token, "sme_basic");

    // Burn some of the old plan's monthly allowance.
    const onOldPlan = await reloadOrg(orgId);
    await recordUsage(onOldPlan, "candidate_views", 40);
    const before = await getOrganizationUsage(orgId);
    expect(before.meters.find((m) => m.key === "candidate_views")?.used).toBe(40);
    expect(before.meters.find((m) => m.key === "candidate_views")?.limit).toBe(50);

    await buyPlan(token, "pro");

    const after = await getOrganizationUsage(orgId);
    expect(after.billingPlan).toBe("pro");
    const views = after.meters.find((m) => m.key === "candidate_views");
    expect(views?.used).toBe(0);
    expect(views?.limit).toBe(250);
    expect(after.flags.some((f) => f.key === "bulk_broadcast_tools" && f.included)).toBe(true);
  });

  it("verifying the same reference twice is a no-op", async () => {
    const { token, orgId } = await createBillableRecruiter();
    const initiated = await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${token}`)
      .send({ planKey: "pro", interval: "monthly" })
      .expect(200);
    const { reference } = initiated.body.data;

    await request(app)
      .post("/v1/payments/verify")
      .set("Authorization", `Bearer ${token}`)
      .send({ reference })
      .expect(200);
    const first = await reloadOrg(orgId);

    await request(app)
      .post("/v1/payments/verify")
      .set("Authorization", `Bearer ${token}`)
      .send({ reference })
      .expect(200);
    const second = await reloadOrg(orgId);

    expect(second.billingPlan).toBe("pro");
    expect(second.billingPeriodEnd!.getTime()).toBe(first.billingPeriodEnd!.getTime());
  });

  it("a concurrent verify and charge.success webhook leave billing consistent", async () => {
    const { token, orgId } = await createBillableRecruiter();
    const initiated = await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${token}`)
      .send({ planKey: "pro", interval: "monthly" })
      .expect(200);
    const { reference } = initiated.body.data;

    const webhookBody = {
      event: "charge.success",
      data: { id: 4242, reference, status: "success", amount: 30_000_000 },
    };

    await Promise.all([
      request(app)
        .post("/v1/payments/verify")
        .set("Authorization", `Bearer ${token}`)
        .send({ reference }),
      request(app)
        .post(WEBHOOK_PATH)
        .set("x-paystack-signature", signBody(webhookBody))
        .send(webhookBody),
    ]);

    const org = await reloadOrg(orgId);
    expect(org.billingPlan).toBe("pro");
    expect(org.billingStatus).toBe(BillingStatus.Active);
    expect(org.billingPeriodEnd).toBeInstanceOf(Date);
  });
});

describe("renewal", () => {
  it("invoice.update extends the paid period", async () => {
    const { user, orgId } = await createBillableRecruiter();
    const plan = await createPlan({
      planKey: "pro",
      interval: BillingInterval.Monthly,
      currency: Currency.NGN,
      paystackAmount: 30_000_000,
    });
    const nearlyOver = new Date(Date.now() + 60_000);
    await setOrganizationBilling(
      orgId,
      {
        billingPlan: "pro",
        billingInterval: BillingInterval.Monthly,
        billingStatus: BillingStatus.Active,
        billingPeriodEnd: nearlyOver,
      },
      PURCHASED
    );
    const sub = await createSubscription(user, plan, {
      organizationId: orgId,
      status: SubscriptionStatus.Active,
      nextPaymentDate: nearlyOver,
    });

    const nextPaymentDate = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    const body = {
      event: "invoice.update",
      data: {
        id: 77,
        invoice_code: "INV_renewal_1",
        paid: true,
        status: "success",
        subscription: {
          subscription_code: sub.paystackSubscriptionCode,
          next_payment_date: nextPaymentDate.toISOString(),
        },
      },
    };

    await request(app)
      .post(WEBHOOK_PATH)
      .set("x-paystack-signature", signBody(body))
      .send(body)
      .expect(200);

    const org = await reloadOrg(orgId);
    expect(org.billingPlan).toBe("pro");
    expect(org.billingPeriodEnd!.getTime()).toBeGreaterThan(nearlyOver.getTime());

    const renewed = await testDataSource
      .getRepository(Subscription)
      .findOne({ where: { id: sub.id } });
    expect(renewed!.nextPaymentDate!.getTime()).toBe(nextPaymentDate.getTime());
    expect(renewed!.expiryDate!.getTime()).toBe(nextPaymentDate.getTime());
  });

  it("an unpaid invoice.create does not extend anything", async () => {
    const { user, orgId } = await createBillableRecruiter();
    const plan = await createPlan({
      planKey: "pro",
      interval: BillingInterval.Monthly,
      currency: Currency.NGN,
      paystackAmount: 30_000_000,
    });
    const periodEnd = new Date(Date.now() + 60_000);
    await setOrganizationBilling(
      orgId,
      {
        billingPlan: "pro",
        billingInterval: BillingInterval.Monthly,
        billingStatus: BillingStatus.Active,
        billingPeriodEnd: periodEnd,
      },
      PURCHASED
    );
    const sub = await createSubscription(user, plan, {
      organizationId: orgId,
      status: SubscriptionStatus.Active,
    });

    const body = {
      event: "invoice.create",
      data: {
        id: 78,
        invoice_code: "INV_pending_1",
        paid: false,
        status: "pending",
        subscription: { subscription_code: sub.paystackSubscriptionCode },
      },
    };

    await request(app)
      .post(WEBHOOK_PATH)
      .set("x-paystack-signature", signBody(body))
      .send(body)
      .expect(200);

    const org = await reloadOrg(orgId);
    expect(org.billingPeriodEnd!.getTime()).toBe(periodEnd.getTime());
  });

  it("a late renewal for a replaced plan does not clobber a newer upgrade", async () => {
    const { user, orgId } = await createBillableRecruiter();
    const oldPlan = await createPlan({
      planKey: "sme_basic",
      interval: BillingInterval.Monthly,
      currency: Currency.NGN,
      paystackAmount: 15_000_000,
    });
    const oldSub = await createSubscription(user, oldPlan, {
      organizationId: orgId,
      status: SubscriptionStatus.Active,
    });

    // The org has already moved on to a richer plan.
    const upgradedUntil = computeBillingPeriodEnd(new Date(), BillingInterval.Monthly);
    await setOrganizationBilling(
      orgId,
      {
        billingPlan: "pro",
        billingInterval: BillingInterval.Monthly,
        billingStatus: BillingStatus.Active,
        billingPeriodEnd: upgradedUntil,
      },
      PURCHASED
    );

    const body = {
      event: "invoice.update",
      data: {
        id: 79,
        invoice_code: "INV_late_1",
        paid: true,
        status: "success",
        subscription: {
          subscription_code: oldSub.paystackSubscriptionCode,
          next_payment_date: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
        },
      },
    };

    await request(app)
      .post(WEBHOOK_PATH)
      .set("x-paystack-signature", signBody(body))
      .send(body)
      .expect(200);

    const org = await reloadOrg(orgId);
    expect(org.billingPlan).toBe("pro");
    expect(org.billingPeriodEnd!.getTime()).toBe(upgradedUntil.getTime());
  });
});

describe("expiry", () => {
  const expirePlan = async (orgId: string, planKey = "pro") => {
    await setOrganizationBilling(
      orgId,
      {
        billingPlan: planKey,
        billingInterval: BillingInterval.Monthly,
        billingStatus: BillingStatus.Active,
        billingPeriodEnd: new Date(Date.now() - 3600_000),
      },
      PURCHASED
    );
  };

  it("reverts to pay_per_use once the paid period has passed", async () => {
    const { orgId } = await createBillableRecruiter();
    await expirePlan(orgId);

    const checked = await ensureOrganizationBillingCurrent(await reloadOrg(orgId));
    expect(checked.billingPlan).toBe(DEFAULT_BILLING_PLAN_KEY);

    const org = await reloadOrg(orgId);
    expect(org.billingPlan).toBe(DEFAULT_BILLING_PLAN_KEY);
    expect(org.billingInterval).toBeNull();
    expect(org.billingStatus).toBe(BillingStatus.Cancelled);
    expect(org.billingPeriodEnd).toBeNull();
  });

  // Minutes, not hours, from the boundary: comparing the stored timestamps with the database's
  // own clock is off by the server's UTC offset, which these would fall inside.
  describe("right at the edge of the paid period", () => {
    it("a period that ended minutes ago is reverted", async () => {
      const { orgId } = await createBillableRecruiter();
      await setOrganizationBilling(
        orgId,
        {
          billingPlan: "pro",
          billingInterval: BillingInterval.Monthly,
          billingStatus: BillingStatus.Active,
          billingPeriodEnd: new Date(Date.now() - 10 * 60_000),
        },
        PURCHASED
      );

      const checked = await ensureOrganizationBillingCurrent(await reloadOrg(orgId));

      expect(checked.billingPlan).toBe(DEFAULT_BILLING_PLAN_KEY);
      expect((await reloadOrg(orgId)).billingPlan).toBe(DEFAULT_BILLING_PLAN_KEY);
    });

    it("a subscription renewing in minutes still keeps the plan", async () => {
      const { user, orgId } = await createBillableRecruiter();
      const plan = await createPlan({
        planKey: "pro",
        interval: BillingInterval.Monthly,
        currency: Currency.NGN,
        paystackAmount: 30_000_000,
      });
      await expirePlan(orgId);
      await createSubscription(user, plan, {
        organizationId: orgId,
        status: SubscriptionStatus.Active,
        nextPaymentDate: new Date(Date.now() + 10 * 60_000),
      });

      await revertToPayPerUseIfExpired(orgId);

      expect((await reloadOrg(orgId)).billingPlan).toBe("pro");
    });
  });

  it("does NOT downgrade an org whose subscription is still live (dropped renewal webhook)", async () => {
    const { user, orgId } = await createBillableRecruiter();
    const plan = await createPlan({
      planKey: "pro",
      interval: BillingInterval.Monthly,
      currency: Currency.NGN,
      paystackAmount: 30_000_000,
    });
    await expirePlan(orgId);
    const stillPaying = new Date(Date.now() + 20 * 24 * 3600 * 1000);
    await createSubscription(user, plan, {
      organizationId: orgId,
      status: SubscriptionStatus.Active,
      nextPaymentDate: stillPaying,
    });

    const checked = await ensureOrganizationBillingCurrent(await reloadOrg(orgId));
    expect(checked.billingPlan).toBe("pro");

    const org = await reloadOrg(orgId);
    expect(org.billingPlan).toBe("pro");
    expect(org.billingStatus).toBe(BillingStatus.Active);
    expect(org.billingPeriodEnd!.getTime()).toBe(stillPaying.getTime());
  });

  it("after expiry, job activation needs payment again", async () => {
    const { user, token, orgId } = await createBillableRecruiter();
    await expirePlan(orgId);
    const role = await createRole();
    const config = await createAIConfig(user);
    const draft = await createJob(user, role, {
      organizationId: orgId,
      status: JobStatus.Draft,
      aiConfigId: config.id,
    });

    const res = await request(app)
      .patch(`/v1/jobs/${draft.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "active" })
      .expect(200);
    expect(res.body.data.job.status).toBe("pending_payment");
  });

  it("subscription.disable reverts to pay_per_use, never free", async () => {
    const { user, orgId } = await createBillableRecruiter();
    const plan = await createPlan({
      planKey: "pro",
      interval: BillingInterval.Monthly,
      currency: Currency.NGN,
      paystackAmount: 30_000_000,
    });
    await setOrganizationBilling(
      orgId,
      {
        billingPlan: "pro",
        billingInterval: BillingInterval.Monthly,
        billingStatus: BillingStatus.Active,
        billingPeriodEnd: computeBillingPeriodEnd(new Date(), BillingInterval.Monthly),
      },
      PURCHASED
    );
    const sub = await createSubscription(user, plan, {
      organizationId: orgId,
      status: SubscriptionStatus.Active,
    });

    const body = {
      event: "subscription.disable",
      data: { id: 90, subscription_code: sub.paystackSubscriptionCode },
    };

    await request(app)
      .post(WEBHOOK_PATH)
      .set("x-paystack-signature", signBody(body))
      .send(body)
      .expect(200);

    const org = await reloadOrg(orgId);
    expect(org.billingPlan).toBe(DEFAULT_BILLING_PLAN_KEY);
    expect(org.billingStatus).toBe(BillingStatus.Cancelled);
    expect(org.billingPeriodEnd).toBeNull();

    const cancelled = await testDataSource
      .getRepository(Subscription)
      .findOne({ where: { id: sub.id } });
    expect(cancelled!.status).toBe(SubscriptionStatus.Cancelled);
  });

  it("subscription.disable for a plan the org already left is ignored", async () => {
    const { user, orgId } = await createBillableRecruiter();
    const oldPlan = await createPlan({
      planKey: "sme_basic",
      interval: BillingInterval.Monthly,
      currency: Currency.NGN,
      paystackAmount: 15_000_000,
    });
    const oldSub = await createSubscription(user, oldPlan, {
      organizationId: orgId,
      status: SubscriptionStatus.Active,
    });
    const upgradedUntil = computeBillingPeriodEnd(new Date(), BillingInterval.Monthly);
    await setOrganizationBilling(
      orgId,
      {
        billingPlan: "pro",
        billingInterval: BillingInterval.Monthly,
        billingStatus: BillingStatus.Active,
        billingPeriodEnd: upgradedUntil,
      },
      PURCHASED
    );

    const body = {
      event: "subscription.disable",
      data: { id: 91, subscription_code: oldSub.paystackSubscriptionCode },
    };

    await request(app)
      .post(WEBHOOK_PATH)
      .set("x-paystack-signature", signBody(body))
      .send(body)
      .expect(200);

    const org = await reloadOrg(orgId);
    expect(org.billingPlan).toBe("pro");
    expect(org.billingPeriodEnd!.getTime()).toBe(upgradedUntil.getTime());
  });
});

describe("usage counters", () => {
  it("concurrent increments are not lost", async () => {
    const { orgId } = await createBillableRecruiter();
    await setOrganizationBilling(
      orgId,
      {
        billingPlan: "advance",
        billingInterval: BillingInterval.Monthly,
        billingStatus: BillingStatus.Active,
        billingPeriodEnd: computeBillingPeriodEnd(new Date(), BillingInterval.Monthly),
      },
      PURCHASED
    );
    const org = await reloadOrg(orgId);

    await Promise.all(Array.from({ length: 12 }, () => recordUsage(org, "candidate_views")));

    const counter = await testDataSource
      .getRepository(FeatureUsageCounter)
      .findOne({ where: { organizationId: orgId, featureKey: "candidate_views" } });
    expect(counter!.count).toBe(12);
  });
});

describe("GET /v1/organizations/:id/usage", () => {
  it("returns the current plan's meters to the owner", async () => {
    const { token, orgId } = await createBillableRecruiter();

    const res = await request(app)
      .get(`/v1/organizations/${orgId}/usage`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(res.body.data.usage.billingPlan).toBe(DEFAULT_BILLING_PLAN_KEY);
    expect(res.body.data.usage.meters.length).toBeGreaterThan(0);
  });

  it("rejects a recruiter who is not a member of the company", async () => {
    const { orgId } = await createBillableRecruiter();
    const { token: outsiderToken } = await createBillableRecruiter();

    await request(app)
      .get(`/v1/organizations/${orgId}/usage`)
      .set("Authorization", `Bearer ${outsiderToken}`)
      .expect(403);
  });

  it("requires authentication", async () => {
    const { orgId } = await createBillableRecruiter();
    await request(app).get(`/v1/organizations/${orgId}/usage`).expect(401);
  });
});

// ---------------------------------------------------------------------------
// Per-job payment: edge and error cases, and overflow from a full subscription.
// ---------------------------------------------------------------------------

const jobRepo = () => testDataSource.getRepository(Job);

const inAMonth = () => computeBillingPeriodEnd(new Date(), BillingInterval.Monthly);

const onPlan = (orgId: string, billingPlan: string, billingPeriodEnd: Date = inAMonth()) =>
  setOrganizationBilling(
    orgId,
    {
      billingPlan,
      billingInterval: BillingInterval.Monthly,
      billingStatus: BillingStatus.Active,
      billingPeriodEnd,
    },
    PURCHASED
  );

async function payableDraft(user: User, orgId: string): Promise<Job> {
  const role = await createRole();
  const config = await createAIConfig(user);
  return createJob(user, role, {
    organizationId: orgId,
    status: JobStatus.Draft,
    aiConfigId: config.id,
  });
}

async function payForJob(token: string, jobId: string): Promise<string> {
  const initiated = await request(app)
    .post(`/v1/jobs/${jobId}/activate-payment`)
    .set("Authorization", `Bearer ${token}`)
    .expect(200);
  return initiated.body.data.reference as string;
}

const verifyReference = (token: string, reference: string) =>
  request(app)
    .post("/v1/payments/verify")
    .set("Authorization", `Bearer ${token}`)
    .send({ reference });

describe("per-job payment — edge and error cases", () => {
  it("a recruiter from another company cannot pay for the job → 403", async () => {
    const { user, orgId } = await createBillableRecruiter();
    const { token: outsiderToken } = await createBillableRecruiter();
    const draft = await payableDraft(user, orgId);

    await request(app)
      .post(`/v1/jobs/${draft.id}/activate-payment`)
      .set("Authorization", `Bearer ${outsiderToken}`)
      .expect(403);
  });

  it("paying for a job that does not exist → 404", async () => {
    const { token } = await createBillableRecruiter();
    await request(app)
      .post(`/v1/jobs/00000000-0000-4000-8000-000000000000/activate-payment`)
      .set("Authorization", `Bearer ${token}`)
      .expect(404);
  });

  it("unauthenticated → 401", async () => {
    const { user, orgId } = await createBillableRecruiter();
    const draft = await payableDraft(user, orgId);
    await request(app).post(`/v1/jobs/${draft.id}/activate-payment`).expect(401);
  });

  it("a job closed while its payment was pending is not reactivated when the payment lands", async () => {
    const { user, token, orgId } = await createBillableRecruiter();
    const draft = await payableDraft(user, orgId);
    const reference = await payForJob(token, draft.id);

    await jobRepo().update(draft.id, { status: JobStatus.Closed });
    await verifyReference(token, reference).expect(200);

    const job = await jobRepo().findOne({ where: { id: draft.id } });
    expect(job!.status).toBe(JobStatus.Closed);
  });

  it("verifying the same job payment twice activates it once and reports the job both times", async () => {
    const { user, token, orgId } = await createBillableRecruiter();
    const draft = await payableDraft(user, orgId);
    const reference = await payForJob(token, draft.id);

    const first = await verifyReference(token, reference).expect(200);
    const second = await verifyReference(token, reference).expect(200);

    expect(first.body.data.jobId).toBe(draft.id);
    expect(second.body.data.jobId).toBe(draft.id);
    const completed = await testDataSource
      .getRepository(Payment)
      .count({ where: { organizationId: orgId, status: PaymentStatus.Completed } });
    expect(completed).toBe(1);
    expect((await jobRepo().findOne({ where: { id: draft.id } }))!.status).toBe(JobStatus.Active);
  });

  it("an expired subscription falls back to paying per job", async () => {
    const { user, token, orgId } = await createBillableRecruiter();
    await onPlan(orgId, "pro", new Date(Date.now() - 3600_000));
    const draft = await payableDraft(user, orgId);

    await payForJob(token, draft.id);

    const org = await reloadOrg(orgId);
    expect(org.billingPlan).toBe(DEFAULT_BILLING_PLAN_KEY);
  });

  it("a per-job charge is for the pay-per-use price", async () => {
    const { user, token, orgId } = await createBillableRecruiter();
    const draft = await payableDraft(user, orgId);
    await payForJob(token, draft.id);

    const payment = await testDataSource
      .getRepository(Payment)
      .findOne({ where: { organizationId: orgId } });
    expect(payment!.amount).toBe(75_000);
    expect(payment!.planId).toBeNull();
    expect(payment!.billingInterval).toBeNull();
  });
});

describe("quota overflow — a full subscription pays per job for extra listings", () => {
  async function fullSmeBasic() {
    const billable = await createBillableRecruiter();
    await onPlan(billable.orgId, "sme_basic");
    const role = await createRole();
    const config = await createAIConfig(billable.user);
    for (let i = 0; i < 2; i += 1) {
      await createJob(billable.user, role, {
        organizationId: billable.orgId,
        status: JobStatus.Active,
        aiConfigId: config.id,
      });
    }
    return billable;
  }

  it("activation → pending_payment → pay → live, and the subscription is kept", async () => {
    const { user, token, orgId } = await fullSmeBasic();
    const draft = await payableDraft(user, orgId);

    const activated = await request(app)
      .patch(`/v1/jobs/${draft.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "active" })
      .expect(200);
    expect(activated.body.data.job.status).toBe("pending_payment");

    const reference = await payForJob(token, draft.id);
    const verified = await verifyReference(token, reference).expect(200);
    expect(verified.body.data.jobId).toBe(draft.id);

    expect((await jobRepo().findOne({ where: { id: draft.id } }))!.status).toBe(JobStatus.Active);
    const org = await reloadOrg(orgId);
    expect(org.billingPlan).toBe("sme_basic");
    expect(org.billingStatus).toBe(BillingStatus.Active);
    expect(
      await jobRepo().count({ where: { organizationId: orgId, status: JobStatus.Active } })
    ).toBe(3);
  });

  it("paying for an overflow job does not reset the plan's monthly usage", async () => {
    const { user, token, orgId } = await fullSmeBasic();
    await recordUsage(await reloadOrg(orgId), "candidate_views", 30);
    const draft = await payableDraft(user, orgId);

    await verifyReference(token, await payForJob(token, draft.id)).expect(200);

    const usage = await getOrganizationUsage(orgId);
    expect(usage.meters.find((m) => m.key === "candidate_views")?.used).toBe(30);
  });

  it("per-job checkout is refused again once a listing slot frees up", async () => {
    const { user, token, orgId } = await fullSmeBasic();
    const draft = await payableDraft(user, orgId);
    const [first] = await jobRepo().find({
      where: { organizationId: orgId, status: JobStatus.Active },
    });
    await jobRepo().update(first!.id, { status: JobStatus.Closed });

    await request(app)
      .post(`/v1/jobs/${draft.id}/activate-payment`)
      .set("Authorization", `Bearer ${token}`)
      .expect(400);
  });

  it("an unlimited plan never needs per-job checkout", async () => {
    const { user, token, orgId } = await createBillableRecruiter();
    await onPlan(orgId, "enterprise");
    const draft = await payableDraft(user, orgId);

    await request(app)
      .post(`/v1/jobs/${draft.id}/activate-payment`)
      .set("Authorization", `Bearer ${token}`)
      .expect(400);
  });
});

// ---------------------------------------------------------------------------
// Switching plans: usage and billing from the old plan must not leak into the new one.
// ---------------------------------------------------------------------------

const viewsUsed = async (orgId: string): Promise<number> =>
  (await getOrganizationUsage(orgId)).meters.find((m) => m.key === "candidate_views")?.used ?? 0;

const sendWebhook = (body: object) =>
  request(app)
    .post(WEBHOOK_PATH)
    .set("x-paystack-signature", signBody(body))
    .send(body)
    .expect(200);

const monthlyPlanRow = (planKey: string, paystackAmount: number) =>
  createPlan({
    planKey,
    interval: BillingInterval.Monthly,
    currency: Currency.NGN,
    paystackAmount,
    paystackPlanCode: `PLN_${planKey}_${Date.now()}`,
  });

describe("plan switching keeps plans separate", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("expiring back to pay_per_use starts with zero monthly usage", async () => {
    const { orgId } = await createBillableRecruiter();
    await onPlan(orgId, "pro", new Date(Date.now() - 3600_000));
    // Seeded directly: recordUsage would itself notice the expiry and revert first.
    await testDataSource.getRepository(FeatureUsageCounter).save({
      organizationId: orgId,
      featureKey: "candidate_views",
      periodStart: currentPeriodStart(),
      count: 200,
    });

    await ensureOrganizationBillingCurrent(await reloadOrg(orgId));

    const usage = await getOrganizationUsage(orgId);
    expect(usage.billingPlan).toBe(DEFAULT_BILLING_PLAN_KEY);
    const views = usage.meters.find((m) => m.key === "candidate_views");
    expect(views?.used).toBe(0);
    expect(views?.limit).toBe(25);
  });

  it("subscription.disable back to pay_per_use starts with zero monthly usage", async () => {
    const { user, orgId } = await createBillableRecruiter();
    const plan = await monthlyPlanRow("pro", 30_000_000);
    await onPlan(orgId, "pro");
    await recordUsage(await reloadOrg(orgId), "candidate_views", 200);
    const sub = await createSubscription(user, plan, { organizationId: orgId });

    await sendWebhook({
      event: "subscription.disable",
      data: { id: 501, subscription_code: sub.paystackSubscriptionCode },
    });

    expect((await reloadOrg(orgId)).billingPlan).toBe(DEFAULT_BILLING_PLAN_KEY);
    expect(await viewsUsed(orgId)).toBe(0);
  });

  it("subscription.enable onto a different plan applies it and resets usage", async () => {
    const { user, orgId } = await createBillableRecruiter();
    const plan = await monthlyPlanRow("pro", 30_000_000);
    await onPlan(orgId, "sme_basic");
    await recordUsage(await reloadOrg(orgId), "candidate_views", 45);
    const sub = await createSubscription(user, plan, {
      organizationId: orgId,
      status: SubscriptionStatus.Cancelled,
    });

    await sendWebhook({
      event: "subscription.enable",
      data: { id: 502, subscription_code: sub.paystackSubscriptionCode },
    });

    const usage = await getOrganizationUsage(orgId);
    expect(usage.billingPlan).toBe("pro");
    expect(usage.meters.find((m) => m.key === "candidate_views")?.used).toBe(0);
  });

  it("subscription.enable for the plan the org is already on keeps its usage", async () => {
    const { user, orgId } = await createBillableRecruiter();
    const plan = await monthlyPlanRow("pro", 30_000_000);
    await onPlan(orgId, "pro");
    await recordUsage(await reloadOrg(orgId), "candidate_views", 120);
    const sub = await createSubscription(user, plan, { organizationId: orgId });

    await sendWebhook({
      event: "subscription.enable",
      data: { id: 503, subscription_code: sub.paystackSubscriptionCode },
    });

    expect(await viewsUsed(orgId)).toBe(120);
  });

  it("subscription.create for a new plan applies it and resets usage", async () => {
    const { user, orgId } = await createBillableRecruiter();
    const plan = await monthlyPlanRow("pro", 30_000_000);
    await onPlan(orgId, "sme_basic");
    await recordUsage(await reloadOrg(orgId), "candidate_views", 45);

    await sendWebhook({
      event: "subscription.create",
      data: {
        id: 504,
        subscription_code: "SUB_brand_new",
        plan: { plan_code: plan.paystackPlanCode },
        customer: { email: user.email },
      },
    });

    const usage = await getOrganizationUsage(orgId);
    expect(usage.billingPlan).toBe("pro");
    expect(usage.meters.find((m) => m.key === "candidate_views")?.used).toBe(0);
  });

  it("a late subscription.enable for a replaced subscription does not overwrite the newer plan", async () => {
    const { user, orgId } = await createBillableRecruiter();
    const oldPlan = await monthlyPlanRow("sme_basic", 15_000_000);
    const newPlan = await monthlyPlanRow("pro", 30_000_000);
    const oldSub = await createSubscription(user, oldPlan, {
      organizationId: orgId,
      status: SubscriptionStatus.Cancelled,
    });
    const newSub = await createSubscription(user, newPlan, { organizationId: orgId });
    await testDataSource
      .getRepository(Subscription)
      .update(oldSub.id, { createdAt: new Date(Date.now() - 24 * 3600 * 1000) });
    await testDataSource.getRepository(Subscription).update(newSub.id, { createdAt: new Date() });
    await onPlan(orgId, "pro");
    await recordUsage(await reloadOrg(orgId), "candidate_views", 10);

    await sendWebhook({
      event: "subscription.enable",
      data: { id: 505, subscription_code: oldSub.paystackSubscriptionCode },
    });

    const org = await reloadOrg(orgId);
    expect(org.billingPlan).toBe("pro");
    expect(await viewsUsed(orgId)).toBe(10);
  });

  it("an upgrade stops Paystack charging for the subscription it replaced", async () => {
    const disable = jest.spyOn(paystack, "disableSubscription");
    const { user, token, orgId } = await createBillableRecruiter();
    const oldPlan = await monthlyPlanRow("sme_basic", 15_000_000);
    await monthlyPlanRow("pro", 30_000_000);
    await onPlan(orgId, "sme_basic");
    const oldSub = await createSubscription(user, oldPlan, {
      organizationId: orgId,
      email_token: "tok_old",
    });

    await buyPlan(token, "pro");

    expect(disable).toHaveBeenCalledTimes(1);
    expect(disable).toHaveBeenCalledWith({
      code: oldSub.paystackSubscriptionCode,
      token: "tok_old",
    });
    const cancelled = await testDataSource
      .getRepository(Subscription)
      .findOne({ where: { id: oldSub.id } });
    expect(cancelled!.status).toBe(SubscriptionStatus.Cancelled);
  });

  it("the first purchase has nothing to disable on Paystack", async () => {
    const disable = jest.spyOn(paystack, "disableSubscription");
    const { token } = await createBillableRecruiter();
    await monthlyPlanRow("pro", 30_000_000);

    await buyPlan(token, "pro");

    expect(disable).not.toHaveBeenCalled();
  });

  it.each([
    ["throws", () => Promise.reject(new Error("Paystack is down"))],
    ["refuses", () => Promise.resolve({ status: false, message: "Subscription not found" })],
  ])("an upgrade still succeeds when Paystack %s the disable", async (_label, outcome) => {
    jest.spyOn(paystack, "disableSubscription").mockImplementation(outcome as never);
    const { user, token, orgId } = await createBillableRecruiter();
    const oldPlan = await monthlyPlanRow("sme_basic", 15_000_000);
    await monthlyPlanRow("pro", 30_000_000);
    await onPlan(orgId, "sme_basic");
    await createSubscription(user, oldPlan, { organizationId: orgId });

    await buyPlan(token, "pro");

    expect((await reloadOrg(orgId)).billingPlan).toBe("pro");
  });

  it("the subscription.disable Paystack sends for the replaced subscription does not undo the upgrade", async () => {
    const { user, token, orgId } = await createBillableRecruiter();
    const oldPlan = await monthlyPlanRow("sme_basic", 15_000_000);
    await monthlyPlanRow("pro", 30_000_000);
    await onPlan(orgId, "sme_basic");
    const oldSub = await createSubscription(user, oldPlan, { organizationId: orgId });
    await buyPlan(token, "pro");
    await recordUsage(await reloadOrg(orgId), "candidate_views", 5);

    await sendWebhook({
      event: "subscription.disable",
      data: { id: 506, subscription_code: oldSub.paystackSubscriptionCode },
    });

    expect((await reloadOrg(orgId)).billingPlan).toBe("pro");
    expect(await viewsUsed(orgId)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Plan history
// ---------------------------------------------------------------------------

const historyRepo = () => testDataSource.getRepository(OrganizationPlanHistory);

const historyOf = (orgId: string) =>
  historyRepo().find({ where: { organizationId: orgId }, order: { createdAt: "ASC" } });

describe("plan history — what gets recorded", () => {
  beforeEach(async () => {
    await monthlyPlanRow("sme_basic", 15_000_000);
    await monthlyPlanRow("pro", 30_000_000);
  });

  it("a new organization has no history", async () => {
    const { orgId } = await createBillableRecruiter();
    expect(await historyOf(orgId)).toEqual([]);
  });

  it("a purchase records the move off pay_per_use and the payment behind it", async () => {
    const { token, orgId } = await createBillableRecruiter();
    await buyPlan(token, "sme_basic");

    const payment = await testDataSource
      .getRepository(Payment)
      .findOne({ where: { organizationId: orgId } });
    const history = await historyOf(orgId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromPlan: DEFAULT_BILLING_PLAN_KEY,
      toPlan: "sme_basic",
      billingInterval: BillingInterval.Monthly,
      reason: PlanChangeReason.Purchase,
      paymentId: payment!.id,
    });
  });

  it("an upgrade then an expiry are both recorded, in order", async () => {
    const { token, orgId } = await createBillableRecruiter();
    await buyPlan(token, "sme_basic");
    await buyPlan(token, "pro");
    await testDataSource
      .getRepository(Organization)
      .update(orgId, { billingPeriodEnd: new Date(Date.now() - 3600_000) });
    await ensureOrganizationBillingCurrent(await reloadOrg(orgId));

    const history = await historyOf(orgId);
    expect(history.map((h) => [h.fromPlan, h.toPlan, h.reason])).toEqual([
      [DEFAULT_BILLING_PLAN_KEY, "sme_basic", PlanChangeReason.Purchase],
      ["sme_basic", "pro", PlanChangeReason.Purchase],
      ["pro", DEFAULT_BILLING_PLAN_KEY, PlanChangeReason.Expired],
    ]);
    expect(history[2]!.billingInterval).toBeNull();
    expect(history[2]!.paymentId).toBeNull();
  });

  it("an expiry check that finds nothing expired records nothing", async () => {
    const { token, orgId } = await createBillableRecruiter();
    await buyPlan(token, "pro");
    await ensureOrganizationBillingCurrent(await reloadOrg(orgId));
    await ensureOrganizationBillingCurrent(await reloadOrg(orgId));

    expect(await historyOf(orgId)).toHaveLength(1);
  });

  it("subscription.disable records the revert", async () => {
    const { user, orgId } = await createBillableRecruiter();
    const plan = await monthlyPlanRow("advance", 50_000_000);
    await onPlan(orgId, "advance");
    const sub = await createSubscription(user, plan, { organizationId: orgId });
    await historyRepo().clear();

    await sendWebhook({
      event: "subscription.disable",
      data: { id: 601, subscription_code: sub.paystackSubscriptionCode },
    });

    const history = await historyOf(orgId);
    expect(history.map((h) => [h.fromPlan, h.toPlan, h.reason])).toEqual([
      ["advance", DEFAULT_BILLING_PLAN_KEY, PlanChangeReason.SubscriptionDisabled],
    ]);
  });

  it("subscription.enable records the change", async () => {
    const { user, orgId } = await createBillableRecruiter();
    const plan = await monthlyPlanRow("advance", 50_000_000);
    const sub = await createSubscription(user, plan, {
      organizationId: orgId,
      status: SubscriptionStatus.Cancelled,
    });

    await sendWebhook({
      event: "subscription.enable",
      data: { id: 602, subscription_code: sub.paystackSubscriptionCode },
    });

    const history = await historyOf(orgId);
    expect(history.map((h) => [h.fromPlan, h.toPlan, h.reason])).toEqual([
      [DEFAULT_BILLING_PLAN_KEY, "advance", PlanChangeReason.SubscriptionEnabled],
    ]);
  });

  it("a renewal of the same plan is not a plan change", async () => {
    const { user, token, orgId } = await createBillableRecruiter();
    await buyPlan(token, "pro");
    const plan = await testDataSource
      .getRepository(Plan)
      .findOne({ where: { planKey: "pro", interval: BillingInterval.Monthly } });
    const sub = await createSubscription(user, plan!, { organizationId: orgId });

    await sendWebhook({
      event: "invoice.update",
      data: {
        id: 603,
        invoice_code: "INV_history_renewal",
        paid: true,
        status: "success",
        subscription: {
          subscription_code: sub.paystackSubscriptionCode,
          next_payment_date: new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString(),
        },
      },
    });

    expect(await historyOf(orgId)).toHaveLength(1);
  });

  it("paying for a single job is not a plan change", async () => {
    const { user, token, orgId } = await createBillableRecruiter();
    const draft = await payableDraft(user, orgId);
    await verifyReference(token, await payForJob(token, draft.id)).expect(200);

    expect(await historyOf(orgId)).toEqual([]);
  });

  it("a failed payment records nothing", async () => {
    const { token, orgId } = await createBillableRecruiter();
    const initiated = await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${token}`)
      .send({ planKey: "pro", interval: "monthly" })
      .expect(200);

    await sendWebhook({
      event: "charge.failed",
      data: { id: 604, reference: initiated.body.data.reference, status: "failed" },
    });

    expect(await historyOf(orgId)).toEqual([]);
  });
});

describe("GET /v1/organizations/:id/plan-history", () => {
  beforeEach(async () => {
    await monthlyPlanRow("sme_basic", 15_000_000);
    await monthlyPlanRow("pro", 30_000_000);
  });

  it("returns the owner's history newest first", async () => {
    const { token, orgId } = await createBillableRecruiter();
    await buyPlan(token, "sme_basic");
    await buyPlan(token, "pro");

    const res = await request(app)
      .get(`/v1/organizations/${orgId}/plan-history`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const history = res.body.data.history as Array<{ fromPlan: string; toPlan: string }>;
    expect(history.map((h) => h.toPlan)).toEqual(["pro", "sme_basic"]);
    expect(history[0]).toMatchObject({
      fromPlan: "sme_basic",
      reason: PlanChangeReason.Purchase,
      billingInterval: BillingInterval.Monthly,
    });
  });

  it("an organization that never changed plan gets an empty list", async () => {
    const { token, orgId } = await createBillableRecruiter();
    const res = await request(app)
      .get(`/v1/organizations/${orgId}/plan-history`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.data.history).toEqual([]);
  });

  it("only returns the requested organization's rows", async () => {
    const { token, orgId } = await createBillableRecruiter();
    const other = await createBillableRecruiter();
    await buyPlan(other.token, "pro");

    const res = await request(app)
      .get(`/v1/organizations/${orgId}/plan-history`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body.data.history).toEqual([]);
  });

  it("a team member who is not the owner can read it", async () => {
    const { token: ownerToken, orgId } = await createBillableRecruiter();
    await buyPlan(ownerToken, "pro");
    const { user: member, token: memberToken } = await createRecruiter();
    await testDataSource
      .getRepository(OrganizationMember)
      .save({ organizationId: orgId, userId: member.id, workEmail: member.email });

    const res = await request(app)
      .get(`/v1/organizations/${orgId}/plan-history`)
      .set("Authorization", `Bearer ${memberToken}`)
      .expect(200);
    expect(res.body.data.history).toHaveLength(1);
  });

  it("a recruiter outside the company → 403", async () => {
    const { orgId } = await createBillableRecruiter();
    const { token: outsiderToken } = await createRecruiter();
    await request(app)
      .get(`/v1/organizations/${orgId}/plan-history`)
      .set("Authorization", `Bearer ${outsiderToken}`)
      .expect(403);
  });

  it("an unknown organization → 404", async () => {
    const { token } = await createBillableRecruiter();
    await request(app)
      .get(`/v1/organizations/00000000-0000-4000-8000-000000000000/plan-history`)
      .set("Authorization", `Bearer ${token}`)
      .expect(404);
  });

  it("a talent → 403", async () => {
    const { orgId } = await createBillableRecruiter();
    const { token } = await createTalent();
    await request(app)
      .get(`/v1/organizations/${orgId}/plan-history`)
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
  });

  it("unauthenticated → 401", async () => {
    const { orgId } = await createBillableRecruiter();
    await request(app).get(`/v1/organizations/${orgId}/plan-history`).expect(401);
  });
});
