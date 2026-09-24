/**
 * Covers the email-verification flow: register issuing a token, verify-email,
 * resend-verification, change-email (unverified-only), and the
 * requireVerifiedEmail gate on protected routes.
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { createRecruiter, createTalent, PLAIN_PASSWORD } from "./helpers/fixtures.js";
import { Organization } from "../src/entities/Organization.js";
import { User } from "../src/entities/User.js";

const sendVerificationEmail = jest.fn().mockResolvedValue(undefined);
const sendWelcome = jest.fn().mockResolvedValue(undefined);

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome,
    sendVerificationEmail,
    sendCompanyInvite: jest.fn().mockResolvedValue(undefined),
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

async function registerAndGetToken(email: string): Promise<string> {
  await request(app).post("/v1/auth/register").send({
    email,
    firstName: "Ver",
    lastName: "Ify",
    password: PLAIN_PASSWORD,
  });
  return sendVerificationEmail.mock.calls[sendVerificationEmail.mock.calls.length - 1][1];
}

describe("POST /v1/auth/register — email verification", () => {
  it("creates an unverified user and sends a verification email, not a welcome email", async () => {
    const res = await request(app).post("/v1/auth/register").send({
      email: "verifyme@example.com",
      firstName: "Ver",
      lastName: "Ify",
      password: PLAIN_PASSWORD,
    });

    expect(res.status).toBe(201);
    expect(res.body.data.user.emailVerifiedAt).toBeNull();
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
    expect(sendWelcome).not.toHaveBeenCalled();
  });

  it("forwards a valid redirectPath into the verification email link", async () => {
    const res = await request(app).post("/v1/auth/register").send({
      email: "verifyredirect@example.com",
      firstName: "Ver",
      lastName: "Ify",
      password: PLAIN_PASSWORD,
      redirectPath: "/apply/11111111-1111-1111-1111-111111111111",
    });

    expect(res.status).toBe(201);
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
    expect(sendVerificationEmail.mock.calls[0][2]).toBe(
      "/apply/11111111-1111-1111-1111-111111111111"
    );
  });

  it("forwards a company-invite redirectPath on recruiter signup", async () => {
    const joinPath =
      "/join-company/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const res = await request(app).post("/v1/auth/register/recruiter").send({
      email: "invitejoin@invitecorp.com",
      firstName: "Inv",
      lastName: "Itee",
      password: PLAIN_PASSWORD,
      redirectPath: joinPath,
    });

    expect(res.status).toBe(201);
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
    expect(sendVerificationEmail.mock.calls[0][2]).toBe(joinPath);
  });

  it.each([
    "https://evil.com",
    "//evil.com",
    "/talentDashboard",
    "javascript:alert(1)",
    "/apply/../../etc/passwd",
  ])("rejects an unsafe redirectPath (%s) → 400, no registration happens", async (redirectPath) => {
    const res = await request(app).post("/v1/auth/register").send({
      email: "verifyunsafe@example.com",
      firstName: "Ver",
      lastName: "Ify",
      password: PLAIN_PASSWORD,
      redirectPath,
    });

    expect(res.status).toBe(400);
    expect(sendVerificationEmail).not.toHaveBeenCalled();

    const user = await testDataSource
      .getRepository(User)
      .findOne({ where: { email: "verifyunsafe@example.com" } });
    expect(user).toBeNull();
  });

  it("does not leak redirectPath onto the returned user object", async () => {
    const res = await request(app).post("/v1/auth/register").send({
      email: "verifynoleak@example.com",
      firstName: "Ver",
      lastName: "Ify",
      password: PLAIN_PASSWORD,
      redirectPath: "/apply/11111111-1111-1111-1111-111111111111",
    });

    expect(res.status).toBe(201);
    expect(res.body.data.user).not.toHaveProperty("redirectPath");
  });
});

describe("POST /v1/auth/verify-email", () => {
  it("verifies the email with a valid token and sends the welcome email exactly once", async () => {
    const token = await registerAndGetToken("verify2@example.com");

    const res = await request(app).post("/v1/auth/verify-email").send({ token });
    expect(res.status).toBe(200);
    expect(sendWelcome).toHaveBeenCalledTimes(1);

    const user = await testDataSource
      .getRepository(User)
      .findOne({ where: { email: "verify2@example.com" } });
    expect(user?.emailVerifiedAt).not.toBeNull();
  });

  it("rejects an invalid token → 401", async () => {
    const res = await request(app)
      .post("/v1/auth/verify-email")
      .send({ token: "not-a-real-token" });
    expect(res.status).toBe(401);
  });

  it("rejects an empty token → 400", async () => {
    const res = await request(app).post("/v1/auth/verify-email").send({ token: "" });
    expect(res.status).toBe(400);
  });

  it("rejects reuse of an already-consumed token → 401, without resending the welcome email", async () => {
    const token = await registerAndGetToken("verify3@example.com");
    await request(app).post("/v1/auth/verify-email").send({ token }).expect(200);
    sendWelcome.mockClear();

    const res = await request(app).post("/v1/auth/verify-email").send({ token });
    expect(res.status).toBe(401);
    expect(sendWelcome).not.toHaveBeenCalled();
  });

  it("sends the welcome email only once under concurrent verify requests", async () => {
    const token = await registerAndGetToken("verify4@example.com");

    const [first, second] = await Promise.all([
      request(app).post("/v1/auth/verify-email").send({ token }),
      request(app).post("/v1/auth/verify-email").send({ token }),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 401]);
    expect(sendWelcome).toHaveBeenCalledTimes(1);
  });
});

describe("POST /v1/auth/resend-verification", () => {
  it("issues a fresh token for an unverified user", async () => {
    const { token: authToken } = await createTalent({ emailVerifiedAt: null });

    const res = await request(app)
      .post("/v1/auth/resend-verification")
      .set("Authorization", `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for an already-verified user (no email sent)", async () => {
    const { token: authToken } = await createTalent();

    const res = await request(app)
      .post("/v1/auth/resend-verification")
      .set("Authorization", `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).post("/v1/auth/resend-verification");
    expect(res.status).toBe(401);
  });

  it("forwards a valid redirectPath into the resent verification email link", async () => {
    const { token: authToken } = await createTalent({ emailVerifiedAt: null });

    const res = await request(app)
      .post("/v1/auth/resend-verification")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ redirectPath: "/apply/22222222-2222-2222-2222-222222222222" });

    expect(res.status).toBe(200);
    expect(sendVerificationEmail.mock.calls[0][2]).toBe(
      "/apply/22222222-2222-2222-2222-222222222222"
    );
  });

  it("rejects an unsafe redirectPath → 400, no email sent", async () => {
    const { token: authToken } = await createTalent({ emailVerifiedAt: null });

    const res = await request(app)
      .post("/v1/auth/resend-verification")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ redirectPath: "https://evil.com" });

    expect(res.status).toBe(400);
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });
});

describe("POST /v1/auth/change-email", () => {
  it("changes the email while unverified and issues a new token", async () => {
    const { user, token: authToken } = await createTalent({ emailVerifiedAt: null });

    const res = await request(app)
      .post("/v1/auth/change-email")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ newEmail: "changed@example.com", currentPassword: PLAIN_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe("changed@example.com");
    expect(res.body.data.token).toBeDefined();

    const updated = await testDataSource.getRepository(User).findOne({ where: { id: user.id } });
    expect(updated?.email).toBe("changed@example.com");
    expect(updated?.emailVerifiedAt).toBeNull();
  });

  it("rejects changing an already-verified email → 409", async () => {
    const { token: authToken } = await createTalent();

    const res = await request(app)
      .post("/v1/auth/change-email")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ newEmail: "changed2@example.com", currentPassword: PLAIN_PASSWORD });

    expect(res.status).toBe(409);
  });

  it("rejects wrong current password → 403", async () => {
    const { token: authToken } = await createTalent({ emailVerifiedAt: null });

    const res = await request(app)
      .post("/v1/auth/change-email")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ newEmail: "changed3@example.com", currentPassword: "WrongPass1!" });

    expect(res.status).toBe(403);
  });

  it("rejects an email already in use by another account → 409", async () => {
    await createTalent({ email: "taken@example.com" });
    const { token: authToken } = await createTalent({ emailVerifiedAt: null });

    const res = await request(app)
      .post("/v1/auth/change-email")
      .set("Authorization", `Bearer ${authToken}`)
      .send({ newEmail: "taken@example.com", currentPassword: PLAIN_PASSWORD });

    expect(res.status).toBe(409);
  });

  it("invalidates the old token after change (tokenVersion increments)", async () => {
    const { token: oldToken } = await createTalent({ emailVerifiedAt: null });

    await request(app)
      .post("/v1/auth/change-email")
      .set("Authorization", `Bearer ${oldToken}`)
      .send({ newEmail: "rotated@example.com", currentPassword: PLAIN_PASSWORD })
      .expect(200);

    const meRes = await request(app).get("/v1/user/me").set("Authorization", `Bearer ${oldToken}`);
    expect(meRes.status).toBe(401);
  });
});

describe("requireVerifiedEmail gate on protected routes", () => {
  it("blocks an unverified user with EMAIL_VERIFICATION_REQUIRED", async () => {
    const { token: authToken } = await createTalent({ emailVerifiedAt: null });

    const res = await request(app)
      .get("/v1/notifications")
      .set("Authorization", `Bearer ${authToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("EMAIL_VERIFICATION_REQUIRED");
  });

  it("allows a verified user through", async () => {
    const { token: authToken } = await createTalent();

    const res = await request(app)
      .get("/v1/notifications")
      .set("Authorization", `Bearer ${authToken}`);

    expect(res.status).toBe(200);
  });

  it("still allows GET /v1/user/me while unverified", async () => {
    const { token: authToken } = await createTalent({ emailVerifiedAt: null });

    const res = await request(app).get("/v1/user/me").set("Authorization", `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.user.emailVerifiedAt).toBeNull();
  });

  it("still allows logout while unverified", async () => {
    const { token: authToken } = await createTalent({ emailVerifiedAt: null });

    const res = await request(app)
      .post("/v1/auth/logout")
      .set("Authorization", `Bearer ${authToken}`);
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/auth/verify-email — company invite auto-accept", () => {
  it("joins a pending company invite when a recruiter verifies their email", async () => {
    const { token: ownerToken } = await createRecruiter({ email: "owner@autoinvite.com" });
    const orgRes = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        name: "Auto Invite Corp",
        domain: "@autoinvite.com",
        email: "contact@autoinvite.com",
        phone: "+2348012345678",
        address: "1 Auto Street",
        industry: "Technology",
        website: "https://autoinvite.com",
      });
    expect(orgRes.status).toBe(201);
    const orgId = orgRes.body.data.organization.id as string;
    // Seats are plan-driven and the owner occupies one, so the company needs room to invite.
    await testDataSource
      .getRepository(Organization)
      .update(orgId, { billingPlan: "enterprise" });

    const inviteRes = await request(app)
      .post(`/v1/organizations/${orgId}/invites`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ email: "joiner@autoinvite.com" });
    expect(inviteRes.status).toBe(201);

    await request(app).post("/v1/auth/register/recruiter").send({
      email: "joiner@autoinvite.com",
      firstName: "Join",
      lastName: "Er",
      password: PLAIN_PASSWORD,
    });

    const verifyToken =
      sendVerificationEmail.mock.calls[sendVerificationEmail.mock.calls.length - 1][1];

    const res = await request(app).post("/v1/auth/verify-email").send({ token: verifyToken });
    expect(res.status).toBe(200);
    expect(res.body.data.joinedCompanyName).toBe("Auto Invite Corp");

    const user = await testDataSource
      .getRepository(User)
      .findOne({ where: { email: "joiner@autoinvite.com" } });
    expect(user?.activeOrganizationId).toBe(orgId);
  });
});
