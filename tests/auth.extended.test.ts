/**
 * Extended auth tests — covers reset-password, change-password, and
 * registration edge cases not covered in auth.test.ts.
 */

import { createHash } from "crypto";
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
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: plant a hashed reset token in DB
// ---------------------------------------------------------------------------

async function plantResetToken(
  userId: string,
  token: string,
  expiryOffsetMs = 2 * 60 * 60 * 1000
): Promise<void> {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiry = new Date(Date.now() + expiryOffsetMs);
  await testDataSource
    .createQueryBuilder()
    .update(User)
    .set({ recoveryCode: tokenHash, recoveryCodeExpiry: expiry })
    .where("id = :id", { id: userId })
    .execute();
}

const RESET_TOKEN = "a".repeat(64);
const NEW_PASSWORD = "NewPassword1!";

// ---------------------------------------------------------------------------
// POST /v1/auth/validate-reset-token
// ---------------------------------------------------------------------------

describe("POST /v1/auth/validate-reset-token", () => {
  it("returns valid:true for a live token without leaking account data", async () => {
    const { user } = await createTalent();
    await plantResetToken(user.id, RESET_TOKEN);

    const res = await request(app)
      .post("/v1/auth/validate-reset-token")
      .send({ token: RESET_TOKEN });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ valid: true });
    expect(JSON.stringify(res.body)).not.toContain(user.email);
    expect(JSON.stringify(res.body)).not.toContain(user.id);
  });

  it("rejects a missing token → 400", async () => {
    const res = await request(app).post("/v1/auth/validate-reset-token").send({ token: "" });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown token → 401", async () => {
    const res = await request(app)
      .post("/v1/auth/validate-reset-token")
      .send({ token: "b".repeat(64) });
    expect(res.status).toBe(401);
  });

  it("rejects an expired token → 401", async () => {
    const { user } = await createTalent();
    await plantResetToken(user.id, RESET_TOKEN, -1);

    const res = await request(app)
      .post("/v1/auth/validate-reset-token")
      .send({ token: RESET_TOKEN });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /v1/auth/reset-password
// ---------------------------------------------------------------------------

describe("POST /v1/auth/reset-password", () => {
  it("resets password with a valid token, returns a session, and allows login with the new password", async () => {
    const { user } = await createTalent();
    await plantResetToken(user.id, RESET_TOKEN);

    const resetRes = await request(app)
      .post("/v1/auth/reset-password")
      .send({ token: RESET_TOKEN, password: NEW_PASSWORD });
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.data.token).toBeDefined();
    expect(resetRes.body.data.user.email).toBe(user.email);

    const loginRes = await request(app)
      .post("/v1/auth/login")
      .send({ email: user.email, password: NEW_PASSWORD });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.data.token).toBeDefined();
  });

  it("rejects reset with an unknown token → 401", async () => {
    const res = await request(app)
      .post("/v1/auth/reset-password")
      .send({ token: "b".repeat(64), password: NEW_PASSWORD });
    expect(res.status).toBe(401);
  });

  it("rejects reset with an expired token → 401", async () => {
    const { user } = await createTalent();
    await plantResetToken(user.id, RESET_TOKEN, -1);

    const res = await request(app)
      .post("/v1/auth/reset-password")
      .send({ token: RESET_TOKEN, password: NEW_PASSWORD });
    expect(res.status).toBe(401);
  });

  it("rejects reuse of a token after a successful reset → 401", async () => {
    const { user } = await createTalent();
    await plantResetToken(user.id, RESET_TOKEN);

    await request(app)
      .post("/v1/auth/reset-password")
      .send({ token: RESET_TOKEN, password: NEW_PASSWORD })
      .expect(200);

    const reuse = await request(app)
      .post("/v1/auth/reset-password")
      .send({ token: RESET_TOKEN, password: "AnotherPass1!" });
    expect(reuse.status).toBe(401);

    const validate = await request(app)
      .post("/v1/auth/validate-reset-token")
      .send({ token: RESET_TOKEN });
    expect(validate.status).toBe(401);
  });

  it("invalidates old JWT after password reset (tokenVersion increments)", async () => {
    const { user, token: oldToken } = await createTalent();
    await plantResetToken(user.id, RESET_TOKEN);

    await request(app)
      .post("/v1/auth/reset-password")
      .send({ token: RESET_TOKEN, password: NEW_PASSWORD })
      .expect(200);

    const meRes = await request(app).get("/v1/user/me").set("Authorization", `Bearer ${oldToken}`);
    expect(meRes.status).toBe(401);
  });

  it("rejects a token with extra characters appended → 401", async () => {
    const { user } = await createTalent();
    await plantResetToken(user.id, RESET_TOKEN);

    const res = await request(app)
      .post("/v1/auth/reset-password")
      .send({ token: `${RESET_TOKEN}XXXXX`, password: NEW_PASSWORD });
    expect(res.status).toBe(401);
  });

  it("rejects an empty token field → 400", async () => {
    const res = await request(app)
      .post("/v1/auth/reset-password")
      .send({ token: "", password: NEW_PASSWORD });
    expect(res.status).toBe(400);
  });

  it("rejects a weak new password → 400", async () => {
    const { user } = await createTalent();
    await plantResetToken(user.id, RESET_TOKEN);

    const res = await request(app)
      .post("/v1/auth/reset-password")
      .send({ token: RESET_TOKEN, password: "weak" });
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

    const res = await request(app).post("/v1/auth/register").send({
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

    const res = await request(app).post("/v1/auth/register/recruiter").send({
      email: "recruiter_dup@example.com",
      firstName: "R",
      lastName: "E",
      password: PLAIN_PASSWORD,
    });
    expect(res.status).toBe(409);
  });
});
