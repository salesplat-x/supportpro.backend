/**
 * Extended auth tests — covers reset-password, change-password, and
 * registration edge cases not covered in auth.test.ts.
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { createTalent, PLAIN_PASSWORD } from "./helpers/fixtures.js";
import { User } from "../src/entities/User.js";
import { generateHashedPassword, signToken } from "../src/utils/crypto.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
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
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: plant OTP in DB
// ---------------------------------------------------------------------------

async function plantOTP(
  userId: string,
  otp: string,
  expiryOffsetMs = 15 * 60 * 1000
): Promise<void> {
  const expiry = new Date(Date.now() + expiryOffsetMs);
  await testDataSource
    .createQueryBuilder()
    .update(User)
    .set({ recoveryCode: otp, recoveryCodeExpiry: expiry })
    .where("id = :id", { id: userId })
    .execute();
}

// ---------------------------------------------------------------------------
// POST /v1/auth/reset-password
// ---------------------------------------------------------------------------

describe("POST /v1/auth/reset-password", () => {
  it("resets password with valid OTP and allows login with new password", async () => {
    const { user } = await createTalent();
    const otp = "789012";
    await plantOTP(user.id, otp);

    const resetRes = await request(app)
      .post("/v1/auth/reset-password")
      .send({ email: user.email, otp, password: "NewPassword1!" });
    expect(resetRes.status).toBe(200);

    const loginRes = await request(app)
      .post("/v1/auth/login")
      .send({ email: user.email, password: "NewPassword1!" });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.data.token).toBeDefined();
  });

  it("rejects reset with wrong OTP → 401", async () => {
    const { user } = await createTalent();
    await plantOTP(user.id, "111111");

    const res = await request(app)
      .post("/v1/auth/reset-password")
      .send({ email: user.email, otp: "999999", password: "NewPassword1!" });
    expect(res.status).toBe(401);
  });

  it("rejects reset with expired OTP → 401", async () => {
    const { user } = await createTalent();
    await plantOTP(user.id, "222222", -1); // expired 1ms ago

    const res = await request(app)
      .post("/v1/auth/reset-password")
      .send({ email: user.email, otp: "222222", password: "NewPassword1!" });
    expect(res.status).toBe(401);
  });

  it("rejects reset for non-existent email → 401", async () => {
    const res = await request(app)
      .post("/v1/auth/reset-password")
      .send({ email: "nobody@example.com", otp: "123456", password: "NewPassword1!" });
    expect(res.status).toBe(401);
  });

  it("invalidates old JWT after password reset (tokenVersion increments)", async () => {
    const { user, token: oldToken } = await createTalent();
    const otp = "345678";
    await plantOTP(user.id, otp);

    await request(app)
      .post("/v1/auth/reset-password")
      .send({ email: user.email, otp, password: "NewPassword1!" })
      .expect(200);

    const meRes = await request(app).get("/v1/user/me").set("Authorization", `Bearer ${oldToken}`);
    expect(meRes.status).toBe(401);
  });

  it("ISSUE-001: OTP with correct prefix + extra chars is accepted (proves the bug)", async () => {
    const { user } = await createTalent();
    const otp = "456789";
    await plantOTP(user.id, otp);

    // Append extra characters to the correct OTP
    const paddedOTP = otp + "XXXXX";
    const res = await request(app)
      .post("/v1/auth/reset-password")
      .send({ email: user.email, otp: paddedOTP, password: "NewPassword1!" });

    // BUG (ISSUE-001): this returns 200 but should return 401
    // When fixed, change this expectation to: expect(res.status).toBe(401)
    expect(res.status).toBe(200); // Demonstrates ISSUE-001 is present
  });

  it("rejects empty OTP field → 400", async () => {
    const { user } = await createTalent();
    const res = await request(app)
      .post("/v1/auth/reset-password")
      .send({ email: user.email, otp: "", password: "NewPassword1!" });
    expect(res.status).toBe(400);
  });

  it("rejects weak new password → 400", async () => {
    const { user } = await createTalent();
    const otp = "567890";
    await plantOTP(user.id, otp);

    const res = await request(app)
      .post("/v1/auth/reset-password")
      .send({ email: user.email, otp, password: "weak" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/auth/change-password
// ---------------------------------------------------------------------------

describe("POST /v1/auth/change-password", () => {
  it("changes password successfully and returns a new token", async () => {
    const { user } = await createTalent();
    // Must re-hash with known password because createTalent uses PLAIN_PASSWORD
    const knownHash = await generateHashedPassword(PLAIN_PASSWORD);
    await testDataSource.getRepository(User).update(user.id, { password: knownHash });
    const freshToken = signToken(user);

    const res = await request(app)
      .post("/v1/auth/change-password")
      .set("Authorization", `Bearer ${freshToken}`)
      .send({ oldPassword: PLAIN_PASSWORD, newPassword: "ChangedPass1!" });

    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeDefined();
  });

  it("rejects with wrong old password → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ oldPassword: "WrongOldPass1!", newPassword: "ChangedPass1!" });
    expect(res.status).toBe(403);
  });

  it("returns 401 without auth token", async () => {
    const res = await request(app)
      .post("/v1/auth/change-password")
      .send({ oldPassword: PLAIN_PASSWORD, newPassword: "ChangedPass1!" });
    expect(res.status).toBe(401);
  });

  it("invalidates old token after password change", async () => {
    const { user } = await createTalent();
    const knownHash = await generateHashedPassword(PLAIN_PASSWORD);
    await testDataSource.getRepository(User).update(user.id, { password: knownHash });
    const freshToken = signToken(user);

    await request(app)
      .post("/v1/auth/change-password")
      .set("Authorization", `Bearer ${freshToken}`)
      .send({ oldPassword: PLAIN_PASSWORD, newPassword: "ChangedPass1!" })
      .expect(200);

    const meRes = await request(app)
      .get("/v1/user/me")
      .set("Authorization", `Bearer ${freshToken}`);
    expect(meRes.status).toBe(401);
  });

  it("rejects weak new password → 400", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ oldPassword: PLAIN_PASSWORD, newPassword: "short" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/auth/register — edge cases
// ---------------------------------------------------------------------------

describe("POST /v1/auth/register — edge cases", () => {
  it("rejects registration with missing email → 400", async () => {
    const res = await request(app)
      .post("/v1/auth/register")
      .send({ firstName: "A", lastName: "B", password: PLAIN_PASSWORD });
    expect(res.status).toBe(400);
  });

  it("rejects registration with invalid email format → 400", async () => {
    const res = await request(app)
      .post("/v1/auth/register")
      .send({ email: "not-an-email", firstName: "A", lastName: "B", password: PLAIN_PASSWORD });
    expect(res.status).toBe(400);
  });

  it("rejects registration with missing firstName → 400", async () => {
    const res = await request(app)
      .post("/v1/auth/register")
      .send({ email: "new@example.com", lastName: "B", password: PLAIN_PASSWORD });
    expect(res.status).toBe(400);
  });

  it("email is case-insensitively deduplicated (TALENT@EXAMPLE.COM rejected after talent@example.com)", async () => {
    await request(app)
      .post("/v1/auth/register")
      .send({
        email: "casetest@example.com",
        firstName: "A",
        lastName: "B",
        password: PLAIN_PASSWORD,
      })
      .expect(201);

    const res = await request(app)
      .post("/v1/auth/register")
      .send({
        email: "CASETEST@EXAMPLE.COM",
        firstName: "C",
        lastName: "D",
        password: PLAIN_PASSWORD,
      });
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/auth/register/recruiter — edge cases
// ---------------------------------------------------------------------------

describe("POST /v1/auth/register/recruiter — edge cases", () => {
  it("rejects duplicate email → 409", async () => {
    await request(app)
      .post("/v1/auth/register/recruiter")
      .send({
        email: "recruiter_dup@example.com",
        firstName: "R",
        lastName: "E",
        password: PLAIN_PASSWORD,
      })
      .expect(201);

    const res = await request(app)
      .post("/v1/auth/register/recruiter")
      .send({
        email: "recruiter_dup@example.com",
        firstName: "R",
        lastName: "E",
        password: PLAIN_PASSWORD,
      });
    expect(res.status).toBe(409);
  });
});
