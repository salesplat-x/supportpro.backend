/**
 * Sign-up must only save the fields a person fills in on the sign-up form.
 *
 * POST /v1/auth/register and /v1/auth/register/recruiter used to spread the whole
 * request body into the new user, so a caller could send emailVerifiedAt (and skip
 * requireVerifiedEmail), prescreeningScore, an existing user's id, or any other column.
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
import { apiData } from "./helpers/http.js";
import { User } from "../src/entities/User.js";
import { UserRole } from "../src/types/enums.js";
import { compareHashedPassword } from "../src/utils/crypto.js";

type AuthData = { user: { id: string; email: string }; token: string };

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
    sendPasswordReset: jest.fn().mockResolvedValue(undefined),
    sendCompanyInvite: jest.fn().mockResolvedValue(undefined),
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

const signup = {
  email: "eve@example.com",
  firstName: "Eve",
  lastName: "Adams",
  password: PLAIN_PASSWORD,
};

const extraFields = {
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  prescreeningScore: 99,
  prescreeningScoredAt: "2026-01-01T00:00:00.000Z",
  userRole: UserRole.Admin,
  roleChangeCount: 5,
  tokenVersion: 7,
};

const findUser = (email: string) =>
  testDataSource.getRepository(User).findOneOrFail({ where: { email } });

describe("register ignores fields that are not on the sign-up form", () => {
  it.each([
    ["/v1/auth/register", UserRole.Talent],
    ["/v1/auth/register/recruiter", UserRole.Recruiter],
  ])("%s keeps server defaults", async (path, role) => {
    const res = await request(app)
      .post(path)
      .send({ ...signup, ...extraFields });
    expect(res.status).toBe(201);

    const saved = await findUser(signup.email);
    expect(saved.emailVerifiedAt).toBeNull();
    expect(saved.prescreeningScore).toBeNull();
    expect(saved.prescreeningScoredAt).toBeNull();
    expect(saved.userRole).toBe(role);
    expect(saved.roleChangeCount).toBe(0);
    expect(saved.tokenVersion).toBe(0);
  });

  it("a user who sent emailVerifiedAt is still blocked by requireVerifiedEmail", async () => {
    const res = await request(app)
      .post("/v1/auth/register")
      .send({ ...signup, ...extraFields });
    const { token } = apiData<AuthData>(res);

    const blocked = await request(app)
      .get("/v1/notifications")
      .set("Authorization", `Bearer ${token}`);

    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ error: { code: "EMAIL_VERIFICATION_REQUIRED" } });
  });

  it("an id in the body cannot overwrite an existing account", async () => {
    const { user: victim } = await createTalent();

    const res = await request(app)
      .post("/v1/auth/register")
      .send({ ...signup, id: victim.id, password: "Attacker1!" });
    expect(res.status).toBe(201);

    const after = await testDataSource.getRepository(User).findOneOrFail({
      where: { id: victim.id },
      select: { id: true, email: true, password: true },
    });
    expect(after.email).toBe(victim.email);
    expect(await compareHashedPassword(PLAIN_PASSWORD, after.password)).toBe(true);
    expect(apiData<AuthData>(res).user.id).not.toBe(victim.id);
  });

  it("a normal sign-up still saves every form field", async () => {
    const res = await request(app)
      .post("/v1/auth/register")
      .send({ ...signup, middleName: "Grace", country: "Nigeria" });
    expect(res.status).toBe(201);

    const saved = await testDataSource.getRepository(User).findOneOrFail({
      where: { email: signup.email },
      select: {
        id: true,
        email: true,
        password: true,
        firstName: true,
        lastName: true,
        middleName: true,
        country: true,
        userRole: true,
        emailVerifiedAt: true,
      },
    });
    expect(saved).toMatchObject({
      firstName: "Eve",
      lastName: "Adams",
      middleName: "Grace",
      country: "Nigeria",
      userRole: UserRole.Talent,
      emailVerifiedAt: null,
    });
    expect(await compareHashedPassword(PLAIN_PASSWORD, saved.password)).toBe(true);

    const login = await request(app)
      .post("/v1/auth/login")
      .send({ email: signup.email, password: PLAIN_PASSWORD });
    expect(login.status).toBe(200);
  });
});
