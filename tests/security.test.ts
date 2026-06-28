/**
 * Security test suite — cross-cutting authentication, authorization, and known issues.
 *
 * Tests in this file prove the invariants that hold (or should hold) across the entire API:
 *   - Unauthenticated access to protected routes returns 401
 *   - Wrong-role access returns 403
 *   - Malformed/expired/tampered tokens return 401
 *   - Token invalidation works after logout, password change, and password reset
 *   - CORS wildcard is present (ISSUE-007 documentation)
 *   - Unauthenticated payment verification succeeds (ISSUE-002 documentation)
 *   - OTP truncation bypass (ISSUE-001 regression)
 */

import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { createTalent, createRecruiter, createAdmin, createPayment } from "./helpers/fixtures.js";
import { User } from "../src/entities/User.js";
import { generateHashedPassword, signToken } from "../src/utils/crypto.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendPasswordReset: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
}));

jest.mock("../src/utils/integrations/paystack.js", () => ({
  initializePayment: jest.fn(),
  verifyTransaction: jest.fn().mockResolvedValue({
    status: true,
    data: { status: "success", currency: "NGN", amount: 500000 },
  }),
  webhookDataValidation: jest.fn().mockReturnValue(true),
  generatePaymentObject: jest
    .fn()
    .mockReturnValue({ amount: 500000, email: "u@e.com", currency: "NGN" }),
  createCustomer: jest.fn().mockResolvedValue({ status: true }),
  hasRunningSubscription: jest.fn().mockResolvedValue(false),
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

// ---------------------------------------------------------------------------
// Unauthenticated access — protected endpoints must return 401
// ---------------------------------------------------------------------------

describe("Unauthenticated access returns 401", () => {
  const protectedRoutes: Array<[string, string]> = [
    ["GET", "/v1/user/me"],
    ["PATCH", "/v1/user/me"],
    ["GET", "/v1/applications/"],
    ["POST", "/v1/messages/"],
    ["GET", "/v1/messages/"],
    ["GET", "/v1/conversations/"],
    ["GET", "/v1/notifications/"],
    ["POST", "/v1/notifications/"],
    ["GET", "/v1/subscriptions/"],
    ["POST", "/v1/auth/logout"],
    ["POST", "/v1/auth/change-password"],
    ["POST", "/v1/payments/"],
    ["GET", "/v1/payments/"],
  ];

  for (const [method, path] of protectedRoutes) {
    it(`${method} ${path} → 401 without token`, async () => {
      const agent = request(app);
      const lm = method.toLowerCase() as keyof typeof agent;

      const res = await (agent[lm] as any)(path);
      expect(res.status).toBe(401);
    });
  }
});

// ---------------------------------------------------------------------------
// Role-based access — wrong role returns 403
// ---------------------------------------------------------------------------

describe("Role enforcement — Talent blocked from Recruiter-only routes", () => {
  it("Talent cannot create a job → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/jobs/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        role: "engineer",
        jobBrief: "test",
        maxSalary: 100000,
        minSalary: 50000,
        experienceLevel: "1-3 years",
        locationState: "Lagos",
        locationCountry: "Nigeria",
        workMode: ["remote"],
      });
    expect(res.status).toBe(403);
  });

  it("Talent cannot access recruiter dashboard → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .get("/v1/recruiter/dashboard")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("Talent cannot update application status → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .patch("/v1/applications/some-id/status")
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "shortlisted" });
    expect(res.status).toBe(403);
  });

  it("Talent cannot create AI config → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/ai-config/")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Test Config" });
    expect(res.status).toBe(403);
  });

  it("Talent cannot broadcast messages → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/messages/broadcast")
      .set("Authorization", `Bearer ${token}`)
      .send({ applicationId: "some-id", content: "Hello" });
    expect(res.status).toBe(403);
  });

  it("Talent cannot list talent profiles → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app).get("/v1/user/profile/").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe("Role enforcement — Recruiter blocked from Admin-only routes", () => {
  it("Recruiter cannot create a question (Admin only) → 403", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/questions/")
      .set("Authorization", `Bearer ${token}`)
      .send({ type: "prescreening", question: "What?", roleId: "some-id" });
    expect(res.status).toBe(403);
  });

  it("Recruiter cannot create organization → 403", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Org", email: "org@test.com" });
    expect(res.status).toBe(403);
  });

  it("Recruiter cannot create a plan → 403", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/plans/")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Basic", amount: 5000, interval: "monthly" });
    expect(res.status).toBe(403);
  });
});

describe("Role enforcement — Non-Superadmin blocked from error log routes", () => {
  it("Admin cannot access error logs → 403", async () => {
    const { token } = await createAdmin();
    const res = await request(app).get("/v1/error-logs/").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("Recruiter cannot access error logs → 403", async () => {
    const { token } = await createRecruiter();
    const res = await request(app).get("/v1/error-logs/").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("Talent cannot access error logs → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app).get("/v1/error-logs/").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Token validity
// ---------------------------------------------------------------------------

describe("JWT token validation", () => {
  it("Returns 401 for a malformed token string", async () => {
    const res = await request(app)
      .get("/v1/user/me")
      .set("Authorization", "Bearer not.a.valid.jwt");
    expect(res.status).toBe(401);
  });

  it("Returns 401 for a token signed with the wrong secret", async () => {
    const fakeToken = jwt.sign(
      { id: "some-uuid", email: "x@y.com", tokenVersion: 0 },
      "wrong-secret"
    );
    const res = await request(app).get("/v1/user/me").set("Authorization", `Bearer ${fakeToken}`);
    expect(res.status).toBe(401);
  });

  it("Returns 401 when Authorization header is missing the Bearer prefix", async () => {
    const { token } = await createTalent();
    const res = await request(app).get("/v1/user/me").set("Authorization", token); // missing "Bearer "
    expect(res.status).toBe(401);
  });

  it("Returns 401 for a deleted (non-existent) user's token", async () => {
    // Create user, sign token, then delete user from DB
    const { user, token } = await createTalent();
    await testDataSource.getRepository(User).delete(user.id);
    const res = await request(app).get("/v1/user/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("Returns 403 for a deactivated user's token", async () => {
    const { user, token } = await createTalent();
    await testDataSource.getRepository(User).update(user.id, { active: false });
    const res = await request(app).get("/v1/user/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Token invalidation
// ---------------------------------------------------------------------------

describe("Token invalidation after logout", () => {
  it("Old token is rejected after logout (tokenVersion mismatch)", async () => {
    const { token } = await createTalent();

    await request(app).post("/v1/auth/logout").set("Authorization", `Bearer ${token}`).expect(200);

    const res = await request(app).get("/v1/user/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

describe("Token invalidation after password change", () => {
  it("Old token is rejected after password change", async () => {
    const { user } = await createTalent();

    // Patch password directly in DB so we know it
    const newHash = await generateHashedPassword("OldPass1!");
    await testDataSource.getRepository(User).update(user.id, { password: newHash });

    const freshToken = signToken({ ...user, tokenVersion: 0 });

    const changeRes = await request(app)
      .post("/v1/auth/change-password")
      .set("Authorization", `Bearer ${freshToken}`)
      .send({ oldPassword: "OldPass1!", newPassword: "NewPass1!" });
    expect(changeRes.status).toBe(200);

    // Old token should be invalid
    const meRes = await request(app)
      .get("/v1/user/me")
      .set("Authorization", `Bearer ${freshToken}`);
    expect(meRes.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// ISSUE-002: Unauthenticated payment verification (documents the vulnerability)
// ---------------------------------------------------------------------------

describe("ISSUE-002: Unauthenticated payment verification", () => {
  it("POST /v1/payments/verify succeeds without any auth token (documents ISSUE-002)", async () => {
    const { user } = await createTalent();
    const payment = await createPayment(user, undefined, { paystackRef: "PSK_UNAUTHED_TEST" });

    // No Authorization header — endpoint is publicly accessible
    const res = await request(app)
      .post("/v1/payments/verify")
      .send({ reference: payment.paystackRef });

    // This PASSES, proving unauthenticated verification is possible (ISSUE-002)
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// ISSUE-001: OTP truncation bypass (proves the bug exists)
// ---------------------------------------------------------------------------

describe("ISSUE-001: OTP truncation bypass in resetPassword", () => {
  it("OTP longer than the stored code that starts with the correct prefix is incorrectly ACCEPTED", async () => {
    const { user } = await createTalent();

    // Plant a known OTP directly in the DB
    const storedOTP = "123456";
    const futureExpiry = new Date(Date.now() + 15 * 60 * 1000);
    await testDataSource
      .createQueryBuilder()
      .update(User)
      .set({ recoveryCode: storedOTP, recoveryCodeExpiry: futureExpiry })
      .where("id = :id", { id: user.id })
      .execute();

    // Submit an OTP that starts with the correct 6 digits but has extra chars
    const paddedOTP = storedOTP + "EXTRA";
    const res = await request(app)
      .post("/v1/auth/reset-password")
      .send({ email: user.email, otp: paddedOTP, password: "NewPass1!" });

    // This PASSES (200) demonstrating ISSUE-001 — it should return 401
    // When the bug is fixed, this test will return 401 and should be updated
    expect(res.status).toBe(200); // BUG: should be 401
  });
});

// ---------------------------------------------------------------------------
// ISSUE-007: CORS wildcard (documents the configuration)
// ---------------------------------------------------------------------------

describe("ISSUE-007: CORS wildcard origin", () => {
  it("API responds with Access-Control-Allow-Origin: * for any origin", async () => {
    const res = await request(app).get("/v1/").set("Origin", "https://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});
