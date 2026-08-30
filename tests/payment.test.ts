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
import { createTalent, createRecruiter, createPayment } from "./helpers/fixtures.js";
import { Payment } from "../src/entities/Payment.js";
import { User } from "../src/entities/User.js";
import { BillingPlan, BillingStatus, PaymentStatus } from "../src/types/enums.js";

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
  it("returns YAML catalog without auth", async () => {
    const res = await request(app).get("/v1/pricing");
    expect(res.status).toBe(200);
    expect(res.body.data.plans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "free" }),
        expect.objectContaining({ key: "paid", monthlyAmountNgn: 550000 }),
      ])
    );
    expect(res.body.data.comparison.rows.length).toBeGreaterThan(0);
  });
});

describe("POST /v1/payments/ — initialize payment", () => {
  it("Recruiter with paid plan + monthly interval gets a dummy checkout link", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${token}`)
      .send({ planKey: "paid", interval: "monthly" });

    expect(res.status).toBe(200);
    expect(res.body.data.link).toContain("/payment/verify");
    expect(res.body.data.mode).toBe("dummy");
    expect(res.body.data.reference).toBeTruthy();
  });

  it("Stores amount in kobo matching the YAML catalog", async () => {
    const { token, user } = await createRecruiter();
    await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${token}`)
      .send({ planKey: "paid", interval: "monthly" });

    const payment = await testDataSource
      .getRepository(Payment)
      .findOne({ where: { userId: user.id } });
    expect(payment).not.toBeNull();
    expect(payment!.amountKobo).toBe(55_000_000);
    expect(payment!.status).toBe(PaymentStatus.Pending);
  });

  it("Talent cannot initialize a recruiter payment → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/payments/")
      .set("Authorization", `Bearer ${token}`)
      .send({ planKey: "paid", interval: "monthly" });
    expect(res.status).toBe(403);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app)
      .post("/v1/payments/")
      .send({ planKey: "paid", interval: "monthly" });
    expect(res.status).toBe(401);
  });

  it("Missing planKey → 400", async () => {
    const { token } = await createRecruiter();
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

  it("Owner can verify a dummy payment and is upgraded to paid", async () => {
    const { token, user } = await createRecruiter();
    const payment = await createPayment(user, undefined, {
      paystackRef: "PSK_VERIFY_TEST",
      reference: "PSK_VERIFY_TEST",
      amountKobo: 55_000_000,
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
    const billed = await testDataSource.getRepository(User).findOne({ where: { id: user.id } });
    expect(billed!.billingPlan).toBe(BillingPlan.Paid);
    expect(billed!.billingStatus).toBe(BillingStatus.Active);
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
  it("Valid HMAC + charge.success marks payment completed and upgrades user", async () => {
    const { user } = await createRecruiter();
    const payment = await createPayment(user, undefined, {
      paystackRef: "PSK_WEBHOOK_SUCCESS",
      reference: "PSK_WEBHOOK_SUCCESS",
      amountKobo: 55_000_000,
    });

    const body = {
      event: "charge.success",
      data: {
        id: 1,
        reference: payment.paystackRef,
        status: "success",
        amount: 55_000_000,
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
    const billed = await testDataSource.getRepository(User).findOne({ where: { id: user.id } });
    expect(billed!.billingPlan).toBe(BillingPlan.Paid);
  });

  it("Invalid HMAC signature → 401", async () => {
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set("x-paystack-signature", "invalid-signature")
      .send({ event: "charge.success", data: { reference: "ANY", status: "success" } });
    expect(res.status).toBe(401);
  });

  it("charge.failed marks payment failed without upgrading the user", async () => {
    const { user } = await createRecruiter();
    const payment = await createPayment(user, undefined, { paystackRef: "PSK_FAIL" });
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
    const billed = await testDataSource.getRepository(User).findOne({ where: { id: user.id } });
    expect(billed!.billingPlan).toBe(BillingPlan.Free);
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
