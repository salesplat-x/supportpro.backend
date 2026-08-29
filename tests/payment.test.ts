/**
 * Payment tests — initialization, verification, webhook handling.
 * Documents ISSUE-002 (unauthenticated verify) and ISSUE-003 (webhook IP allowlist).
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { createTalent, createPlan, createPayment } from "./helpers/fixtures.js";
import { Payment } from "../src/entities/Payment.js";
import { Subscription } from "../src/entities/Subscription.js";
import { PaymentStatus } from "../src/types/enums.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  })),
}));

const mockInitializePayment = jest.fn().mockResolvedValue({
  status: true,
  data: { authorization_url: "https://checkout.paystack.com/test", reference: "TEST-REF-001" },
});

const mockVerifyTransaction = jest.fn().mockResolvedValue({
  status: true,
  data: {
    status: "success",
    currency: "NGN",
    amount: 500000,
    plan: null,
    authorization: { authorization_code: "AUTH_001" },
  },
});

const mockWebhookValidation = jest.fn().mockReturnValue(true);
const mockCreateCustomer = jest.fn().mockResolvedValue({ status: true });
const mockHasRunningSubscription = jest.fn().mockResolvedValue(false);
const mockCreateSubscriptionSvc = jest.fn().mockResolvedValue(undefined);

// Mock Paystack integration (external HTTP calls)
jest.mock("../src/utils/integrations/paystack.js", () => ({
  initializePayment: (...args: unknown[]) => mockInitializePayment(...args),
  verifyTransaction: (...args: unknown[]) => mockVerifyTransaction(...args),
  webhookDataValidation: (...args: unknown[]) => mockWebhookValidation(...args),
  generatePaymentObject: jest
    .fn()
    .mockImplementation((amount: number, email: string, plan?: string) => ({
      amount,
      email,
      currency: "NGN",
      plan,
    })),
  createCustomer: (...args: unknown[]) => mockCreateCustomer(...args),
  enableSubscription: jest.fn().mockResolvedValue({ status: true }),
  disableSubscription: jest.fn().mockResolvedValue({ status: true }),
  listSubscriptions: jest.fn().mockResolvedValue({ status: true, data: [] }),
  PaymentVerificationStatus: {
    ChargeCompleted: "charge.completed",
    TransferCompleted: "transfer.completed",
    Successful: "successful",
    Success: "success",
    Failed: "failed",
    Error: "error",
  },
}));

// Mock subscription service (hasRunningSubscription is called by payment service)
jest.mock("../src/services/subscription.js", () => ({
  hasRunningSubscription: (...args: unknown[]) => mockHasRunningSubscription(...args),
  createSubscription: (...args: unknown[]) => mockCreateSubscriptionSvc(...args),
  fetchAll: jest.fn().mockResolvedValue([]),
  fetchOne: jest.fn().mockResolvedValue(null),
  fetchByMatch: jest.fn().mockResolvedValue(null),
  enable: jest.fn().mockResolvedValue(undefined),
  disable: jest.fn().mockResolvedValue(undefined),
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
  // Restore defaults
  mockVerifyTransaction.mockResolvedValue({
    status: true,
    data: {
      status: "success",
      currency: "NGN",
      amount: 500000,
      plan: null,
      authorization: { authorization_code: "AUTH_001" },
    },
  });
  mockWebhookValidation.mockReturnValue(true);
  mockHasRunningSubscription.mockResolvedValue(false);
  mockCreateSubscriptionSvc.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// POST /v1/payments/ — initialize payment
// ---------------------------------------------------------------------------

describe("POST /v1/payments/ — initialize payment", () => {
  it("Authenticated user with amount gets payment link → 200", async () => {
    const { token } = await createTalent();

    const res = await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: 5000 });

    expect(res.status).toBe(200);
    expect(res.body.data.link).toBeDefined();
  });

  it("Authenticated user with planId gets payment link → 200", async () => {
    const { token } = await createTalent();
    const plan = await createPlan({ paystackPlanCode: "PLN_test" });

    const res = await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${token}`)
      .send({ planId: plan.id });

    expect(res.status).toBe(200);
    expect(res.body.data.link).toBeDefined();
  });

  it("Both amount and planId provided → 400", async () => {
    const { token } = await createTalent();
    const plan = await createPlan();

    const res = await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: 5000, planId: plan.id });

    expect(res.status).toBe(400);
  });

  it("Neither amount nor planId → 400", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("planId not found → 404", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${token}`)
      .send({ planId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(404);
  });

  it("Plan already subscribed → 409", async () => {
    const { token } = await createTalent();
    const plan = await createPlan({ paystackPlanCode: "PLN_test" });
    mockHasRunningSubscription.mockResolvedValueOnce(true);

    const res = await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${token}`)
      .send({ planId: plan.id });

    expect(res.status).toBe(409);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app).post("/v1/payments/").send({ amount: 5000 });
    expect(res.status).toBe(401);
  });

  it("Payment record created in DB with status=Pending", async () => {
    const { user, token } = await createTalent();

    await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${token}`)
      .send({ amount: 5000 });

    const payment = await testDataSource
      .getRepository(Payment)
      .findOne({ where: { userId: user.id } });
    expect(payment).not.toBeNull();
    expect(payment!.status).toBe(PaymentStatus.Pending);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/payments/ — get payment records
// ---------------------------------------------------------------------------

describe("GET /v1/payments/ — get payment records", () => {
  it("Returns only authenticated user's payments → 200", async () => {
    const { user: userA, token: tokenA } = await createTalent();
    const { user: userB } = await createTalent();
    await createPayment(userA);
    await createPayment(userB);

    const res = await request(app).get("/v1/payments/").set("Authorization", `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    const payments = res.body.data.payments ?? res.body.data;
    expect(Array.isArray(payments)).toBe(true);
    expect(payments.every((p: Payment) => p.userId === userA.id)).toBe(true);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app).get("/v1/payments/");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/payments/verify — ISSUE-002: unauthenticated
// ---------------------------------------------------------------------------

describe("POST /v1/payments/verify — ISSUE-002", () => {
  it("ISSUE-002: verify succeeds without auth token (documents vulnerability)", async () => {
    const { user } = await createTalent();
    const payment = await createPayment(user, undefined, {
      paystackRef: "PSK_VERIFY_TEST",
      status: PaymentStatus.Pending,
      currency: "NGN",
      amount: 5000,
    });

    // No auth header — this should require authentication but doesn't (ISSUE-002)
    const res = await request(app)
      .post("/v1/payments/verify")
      .send({ reference: payment.paystackRef });

    expect(res.status).toBe(200); // BUG: should be 401 (ISSUE-002)
  });

  it("Unknown reference → 404", async () => {
    const res = await request(app)
      .post("/v1/payments/verify")
      .send({ reference: "NONEXISTENT-REF" });
    expect(res.status).toBe(404);
  });

  it("Already verified reference → 409", async () => {
    const { user } = await createTalent();
    const payment = await createPayment(user, undefined, {
      paystackRef: "PSK_ALREADY_DONE",
      status: PaymentStatus.Completed,
    });

    const res = await request(app)
      .post("/v1/payments/verify")
      .send({ reference: payment.paystackRef });

    expect(res.status).toBe(409);
  });

  it("Paystack reports failed status → 400", async () => {
    const { user } = await createTalent();
    const payment = await createPayment(user, undefined, { paystackRef: "PSK_FAIL_TEST" });

    mockVerifyTransaction.mockResolvedValueOnce({
      status: true,
      data: { status: "failed", currency: "NGN", amount: 500000 },
    });

    const res = await request(app)
      .post("/v1/payments/verify")
      .send({ reference: payment.paystackRef });

    expect(res.status).toBe(400);
  });

  it("Payment status updated to Completed on success", async () => {
    const { user } = await createTalent();
    const payment = await createPayment(user, undefined, {
      paystackRef: "PSK_SUCCESS_TEST",
      currency: "NGN",
      amount: 5000,
    });

    await request(app).post("/v1/payments/verify").send({ reference: payment.paystackRef });

    const updated = await testDataSource
      .getRepository(Payment)
      .findOne({ where: { id: payment.id } });
    expect(updated!.status).toBe(PaymentStatus.Completed);
  });

  it("Missing reference → 400", async () => {
    const res = await request(app).post("/v1/payments/verify").send({});
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/payments/dwhdbwnmdn229dnjkdnn83/webhook — Paystack webhook
// ---------------------------------------------------------------------------

describe("POST /payments webhook — Paystack events", () => {
  const WEBHOOK_PATH = "/v1/payments/dwhdbwnmdn229dnjkdnn83/webhook";

  it("Valid HMAC + charge.success event → 200, payment marked Completed", async () => {
    const { user } = await createTalent();
    const payment = await createPayment(user, undefined, {
      paystackRef: "PSK_WEBHOOK_SUCCESS",
      reference: "PSK_WEBHOOK_SUCCESS",
      currency: "NGN",
      amount: 5000,
    });

    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set("x-paystack-signature", "valid-hmac-signature")
      .send({
        event: "charge.success",
        data: {
          reference: payment.paystackRef,
          status: "success",
          authorization: { authorization_code: "AUTH_001" },
        },
      });

    expect(res.status).toBe(200);

    const updated = await testDataSource
      .getRepository(Payment)
      .findOne({ where: { id: payment.id } });
    expect(updated!.status).toBe(PaymentStatus.Completed);
  });

  it("Invalid HMAC signature → 401", async () => {
    mockWebhookValidation.mockReturnValueOnce(false);

    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set("x-paystack-signature", "invalid-signature")
      .send({ event: "charge.success", data: { reference: "ANY", status: "success" } });

    expect(res.status).toBe(401);
  });

  it("charge.success for unknown reference → 200 (silently ignored)", async () => {
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set("x-paystack-signature", "valid-sig")
      .send({ event: "charge.success", data: { reference: "UNKNOWN-REF", status: "success" } });

    expect(res.status).toBe(200);
  });

  it("Already completed payment is idempotent (no double-credit)", async () => {
    const { user } = await createTalent();
    const payment = await createPayment(user, undefined, {
      paystackRef: "PSK_WEBHOOK_IDEM",
      status: PaymentStatus.Completed,
    });

    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set("x-paystack-signature", "valid-sig")
      .send({
        event: "charge.success",
        data: { reference: payment.paystackRef, status: "success" },
      });

    expect(res.status).toBe(200);

    const subs = await testDataSource
      .getRepository(Subscription)
      .find({ where: { userId: user.id } });
    expect(subs.length).toBe(0); // no subscription created for already-completed payment
  });

  it("subscription.disable event cancels subscription", async () => {
    const { user } = await createTalent();
    const plan = await createPlan();
    const { createSubscription: createSubFix } = await import("./helpers/fixtures.js");
    const sub = await createSubFix(user, plan, { paystackSubscriptionCode: "SUB_DISABLE_TEST" });

    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set("x-paystack-signature", "valid-sig")
      .send({
        event: "subscription.disable",
        data: { subscription_code: sub.paystackSubscriptionCode },
      });

    expect(res.status).toBe(200);
    const updated = await testDataSource
      .getRepository(Subscription)
      .findOne({ where: { id: sub.id } });
    expect(updated!.status).toBe("cancelled");
  });

  it("ISSUE-003: webhook accepts requests from any IP (IP allowlist not enforced)", async () => {
    // Send webhook from a request with a spoofed X-Forwarded-For IP
    const { user } = await createTalent();
    const payment = await createPayment(user, undefined, {
      paystackRef: "PSK_FOREIGN_IP",
      currency: "NGN",
      amount: 5000,
    });

    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set("x-paystack-signature", "valid-sig")
      .set("X-Forwarded-For", "1.2.3.4") // not a Paystack IP
      .send({
        event: "charge.success",
        data: { reference: payment.paystackRef, status: "success" },
      });

    // ISSUE-003: This succeeds — IP is never checked
    expect(res.status).toBe(200);
  });
});
