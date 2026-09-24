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
import { Subscription } from "../src/entities/Subscription.js";
import { User } from "../src/entities/User.js";
import {
  BillingStatus,
  BillingInterval,
  Currency,
  DEFAULT_BILLING_PLAN_KEY,
  JobStatus,
  PaymentStatus,
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

    const paid = await testDataSource
      .getRepository(Job)
      .findOne({ where: { id: draft.id } });
    expect(paid!.status).toBe(JobStatus.Active);

    // A per-job charge must never move the org off pay per use.
    const org = await reloadOrg(orgId);
    expect(org.billingPlan).toBe(DEFAULT_BILLING_PLAN_KEY);
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
    expect(
      before.meters.find((m) => m.key === "candidate_views")?.used
    ).toBe(40);
    expect(before.meters.find((m) => m.key === "candidate_views")?.limit).toBe(50);

    await buyPlan(token, "pro");

    const after = await getOrganizationUsage(orgId);
    expect(after.billingPlan).toBe("pro");
    const views = after.meters.find((m) => m.key === "candidate_views");
    expect(views?.used).toBe(0);
    expect(views?.limit).toBe(250);
    expect(after.flags.some((f) => f.key === "bulk_broadcast_tools" && f.included)).toBe(
      true
    );
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
    await setOrganizationBilling(orgId, {
      billingPlan: "pro",
      billingInterval: BillingInterval.Monthly,
      billingStatus: BillingStatus.Active,
      billingPeriodEnd: nearlyOver,
    });
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
    await setOrganizationBilling(orgId, {
      billingPlan: "pro",
      billingInterval: BillingInterval.Monthly,
      billingStatus: BillingStatus.Active,
      billingPeriodEnd: periodEnd,
    });
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
    await setOrganizationBilling(orgId, {
      billingPlan: "pro",
      billingInterval: BillingInterval.Monthly,
      billingStatus: BillingStatus.Active,
      billingPeriodEnd: upgradedUntil,
    });

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
    await setOrganizationBilling(orgId, {
      billingPlan: planKey,
      billingInterval: BillingInterval.Monthly,
      billingStatus: BillingStatus.Active,
      billingPeriodEnd: new Date(Date.now() - 3600_000),
    });
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
    await setOrganizationBilling(orgId, {
      billingPlan: "pro",
      billingInterval: BillingInterval.Monthly,
      billingStatus: BillingStatus.Active,
      billingPeriodEnd: computeBillingPeriodEnd(new Date(), BillingInterval.Monthly),
    });
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
    await setOrganizationBilling(orgId, {
      billingPlan: "pro",
      billingInterval: BillingInterval.Monthly,
      billingStatus: BillingStatus.Active,
      billingPeriodEnd: upgradedUntil,
    });

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
    await setOrganizationBilling(orgId, {
      billingPlan: "advance",
      billingInterval: BillingInterval.Monthly,
      billingStatus: BillingStatus.Active,
      billingPeriodEnd: computeBillingPeriodEnd(new Date(), BillingInterval.Monthly),
    });
    const org = await reloadOrg(orgId);

    await Promise.all(
      Array.from({ length: 12 }, () => recordUsage(org, "candidate_views"))
    );

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
