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
} from "./helpers/fixtures.js";
import { Payment } from "../src/entities/Payment.js";
import { Organization } from "../src/entities/Organization.js";
import { Subscription } from "../src/entities/Subscription.js";
import { User } from "../src/entities/User.js";
import {
  BillingStatus,
  BillingInterval,
  Currency,
  FREE_PLAN_KEY,
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

  it("Switching plans auto-disables the old active subscription", async () => {
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

    const refreshed = await testDataSource
      .getRepository(Subscription)
      .findOne({ where: { id: oldSub.id } });
    expect(refreshed?.status).toBe(SubscriptionStatus.Cancelled);
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
    expect(billed!.billingPlan).toBe(FREE_PLAN_KEY);
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
