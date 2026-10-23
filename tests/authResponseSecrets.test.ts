/**
 * No API response may carry a user's password hash or other secrets.
 *
 * POST /v1/auth/register, /v1/auth/register/recruiter and /v1/auth/login used to
 * return the stored bcrypt hash ("password") inside data.user. These tests walk
 * every response that contains a user object and fail if a secret field appears
 * anywhere in the body (nested objects and arrays included), or if any string
 * value looks like a bcrypt hash.
 */

import request from "supertest";
import type { Response } from "superagent";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import {
  createAdmin,
  createCompleteTalent,
  createRecruiter,
  createTalent,
  PLAIN_PASSWORD,
} from "./helpers/fixtures.js";
import { User } from "../src/entities/User.js";
import { apiData } from "./helpers/http.js";

type AuthData = { user: { id: string; email: string }; token: string };

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
    sendPasswordReset: jest.fn().mockResolvedValue(undefined),
    sendOrganizationInvite: jest.fn().mockResolvedValue(undefined),
  })),
}));

const SECRET_KEYS = [
  "password",
  "passwordHash",
  "emailVerificationTokenHash",
  "emailVerificationTokenExpiresAt",
  "recoveryCode",
  "recoveryCodeExpiry",
];
const BCRYPT_HASH = /^\$2[aby]?\$\d{2}\$/;

/** Every secret found anywhere in a JSON value, as "path: reason". */
function findSecrets(value: unknown, path = "body"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => findSecrets(item, `${path}[${i}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
      const here = `${path}.${key}`;
      const own = SECRET_KEYS.includes(key) ? [`${here}: secret field`] : [];
      return [...own, ...findSecrets(child, here)];
    });
  }
  if (typeof value === "string" && BCRYPT_HASH.test(value)) {
    return [`${path}: looks like a bcrypt hash`];
  }
  return [];
}

function expectNoSecrets(res: Response): void {
  expect(findSecrets(res.body)).toEqual([]);
}

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

describe("findSecrets (test helper)", () => {
  it("finds nested secret fields and bcrypt-looking values", () => {
    const found = findSecrets({
      data: {
        user: { email: "a@b.co", password: "x" },
        list: [{ recoveryCode: "y" }, { note: "$2b$10$abcdefghijklmnopqrstuv" }],
      },
    });
    expect(found).toEqual([
      "body.data.user.password: secret field",
      "body.data.list[0].recoveryCode: secret field",
      "body.data.list[1].note: looks like a bcrypt hash",
    ]);
  });
});

describe("auth routes never return the password hash or other secrets", () => {
  const signup = {
    email: "ada@acmehiring.com",
    firstName: "Ada",
    lastName: "Okafor",
    password: PLAIN_PASSWORD,
  };

  it("POST /v1/auth/register (talent)", async () => {
    const res = await request(app).post("/v1/auth/register").send(signup);
    expect(res.status).toBe(201);
    expect(apiData<AuthData>(res).user.email).toBe(signup.email);
    expect(apiData<AuthData>(res).token).toBeDefined();
    expectNoSecrets(res);
  });

  it("POST /v1/auth/register/recruiter", async () => {
    const res = await request(app).post("/v1/auth/register/recruiter").send(signup);
    expect(res.status).toBe(201);
    expect(apiData<AuthData>(res).user.email).toBe(signup.email);
    expect(apiData<AuthData>(res).token).toBeDefined();
    expectNoSecrets(res);
  });

  it("POST /v1/auth/login", async () => {
    const { user } = await createRecruiter();
    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: user.email, password: PLAIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(apiData<AuthData>(res).user.id).toBe(user.id);
    expectNoSecrets(res);
  });

  it("POST /v1/auth/login still rejects a wrong password", async () => {
    const { user } = await createRecruiter();
    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: user.email, password: "WrongPassword1!" });
    expect(res.status).toBe(403);
  });

  it("POST /v1/auth/reset-password", async () => {
    const { user } = await createTalent();
    const { createHash } = await import("crypto");
    const token = "c".repeat(64);
    await testDataSource.getRepository(User).update(user.id, {
      recoveryCode: createHash("sha256").update(token).digest("hex"),
      recoveryCodeExpiry: new Date(Date.now() + 60 * 60 * 1000),
    });
    const res = await request(app)
      .post("/v1/auth/reset-password")
      .send({ token, password: "NewPassword1!" });
    expect(res.status).toBe(200);
    expectNoSecrets(res);
  });

  it("POST /v1/auth/change-password", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ oldPassword: PLAIN_PASSWORD, newPassword: "NewPassword1!" });
    expect(res.status).toBe(200);
    expectNoSecrets(res);
  });

  it("POST /v1/auth/change-email", async () => {
    const { token } = await createTalent({ emailVerifiedAt: null });
    const res = await request(app)
      .post("/v1/auth/change-email")
      .set("Authorization", `Bearer ${token}`)
      .send({ newEmail: "changed@example.com", currentPassword: PLAIN_PASSWORD });
    expect(res.status).toBe(200);
    expectNoSecrets(res);
  });
});

describe("user, admin and company routes that return users carry no secrets", () => {
  it("GET /v1/user/me", async () => {
    const { token } = await createTalent();
    const res = await request(app).get("/v1/user/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expectNoSecrets(res);
  });

  it("PATCH /v1/user/me", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .patch("/v1/user/me")
      .set("Authorization", `Bearer ${token}`)
      .send({ firstName: "Renamed" });
    expect(res.status).toBe(200);
    expectNoSecrets(res);
  });

  it("GET /v1/user/profile/:id and GET /v1/user/profile/ (recruiter viewing talents)", async () => {
    const { user: talent } = await createCompleteTalent();
    const { token } = await createRecruiter();
    const one = await request(app)
      .get(`/v1/user/profile/${talent.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(one.status).toBe(200);
    expectNoSecrets(one);
    const many = await request(app)
      .get("/v1/user/profile/")
      .set("Authorization", `Bearer ${token}`);
    expect(many.status).toBe(200);
    expectNoSecrets(many);
  });

  it("GET /v1/admin/talents and /v1/admin/recruiters", async () => {
    await createCompleteTalent();
    await createRecruiter();
    const { token } = await createAdmin();
    for (const path of ["/v1/admin/talents", "/v1/admin/recruiters"]) {
      const res = await request(app).get(path).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expectNoSecrets(res);
    }
  });

  it("GET /v1/organizations/:id/members", async () => {
    const reg = await request(app).post("/v1/auth/register/recruiter").send({
      email: "owner@acmehiring.com",
      firstName: "Ada",
      lastName: "Okafor",
      password: PLAIN_PASSWORD,
    });
    const ownerToken = apiData<AuthData>(reg).token;
    await testDataSource
      .getRepository(User)
      .update({ email: "owner@acmehiring.com" }, { emailVerifiedAt: new Date() });
    const org = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        name: "Acme Hiring Ltd",
        domain: "acmehiring.com",
        email: "owner@acmehiring.com",
        phone: "+2348031234567",
        address: "12 Admiralty Way, Lekki, Lagos",
        industry: "Recruitment",
      });
    expect(org.status).toBe(201);
    const res = await request(app)
      .get(
        `/v1/organizations/${apiData<{ organization: { id: string } }>(org).organization.id}/members`
      )
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(apiData<{ members: unknown[] }>(res).members.length).toBeGreaterThan(0);
    expectNoSecrets(res);
  });
});
