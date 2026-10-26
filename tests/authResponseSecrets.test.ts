/**
 * Register and login must not return the user's password hash.
 *
 * POST /v1/auth/register, /v1/auth/register/recruiter and /v1/auth/login used to
 * return the stored bcrypt hash in data.user.password.
 */

import request from "supertest";
import type { Response } from "superagent";
import { createApp } from "../src/app.js";
import { startTestDatabase, stopTestDatabase, clearAllTables } from "./helpers/db.js";
import { createRecruiter, PLAIN_PASSWORD } from "./helpers/fixtures.js";
import { apiData } from "./helpers/http.js";

type AuthData = { user: Record<string, unknown> & { id: string; email: string }; token: string };

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
    sendPasswordReset: jest.fn().mockResolvedValue(undefined),
    sendOrganizationInvite: jest.fn().mockResolvedValue(undefined),
  })),
}));

const BCRYPT_HASH = /\$2[aby]?\$\d{2}\$/;

function expectNoPassword(res: Response): void {
  expect(apiData<AuthData>(res).user).not.toHaveProperty("password");
  expect(JSON.stringify(res.body)).not.toMatch(BCRYPT_HASH);
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

describe("register and login do not return the password hash", () => {
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
    expectNoPassword(res);
  });

  it("POST /v1/auth/register/recruiter", async () => {
    const res = await request(app).post("/v1/auth/register/recruiter").send(signup);
    expect(res.status).toBe(201);
    expect(apiData<AuthData>(res).user.email).toBe(signup.email);
    expect(apiData<AuthData>(res).token).toBeDefined();
    expectNoPassword(res);
  });

  it("POST /v1/auth/login", async () => {
    const { user } = await createRecruiter();
    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: user.email, password: PLAIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(apiData<AuthData>(res).user.id).toBe(user.id);
    expect(apiData<AuthData>(res).token).toBeDefined();
    expectNoPassword(res);
  });
});
