import request from "supertest";
import { createApp } from "../src/app.js";
import { startTestDatabase, stopTestDatabase, clearAllTables, testDataSource } from "./helpers/db.js";
import EmailService from "../src/utils/integrations/email/index.js";
import { User } from "../src/entities/User.js";
import { UserRole } from "../src/types/enums.js";
import { generateHashedPassword } from "../src/utils/crypto.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      sendWelcome: jest.fn().mockResolvedValue(undefined),
      sendPasswordReset: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

const PLAIN_PASSWORD = "Password1!";

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

describe("POST /v1/auth/register", () => {
  it("registers a new talent and returns a JWT", async () => {
    const res = await request(app).post("/v1/auth/register").send({
      email: "talent@example.com",
      firstName: "Jane",
      lastName: "Doe",
      password: PLAIN_PASSWORD,
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.user.email).toBe("talent@example.com");
    expect(res.body.data.user.userRole).toBe(UserRole.Talent);
  });

  it("registers a recruiter with correct role", async () => {
    const res = await request(app).post("/v1/auth/register/recruiter").send({
      email: "recruiter@example.com",
      firstName: "Bob",
      lastName: "Smith",
      password: PLAIN_PASSWORD,
    });

    expect(res.status).toBe(201);
    expect(res.body.data.user.userRole).toBe(UserRole.Recruiter);
  });

  it("rejects duplicate email", async () => {
    await request(app).post("/v1/auth/register").send({
      email: "dup@example.com",
      firstName: "A",
      lastName: "B",
      password: PLAIN_PASSWORD,
    });

    const res = await request(app).post("/v1/auth/register").send({
      email: "dup@example.com",
      firstName: "C",
      lastName: "D",
      password: PLAIN_PASSWORD,
    });

    expect(res.status).toBe(409);
  });

  it("rejects weak password", async () => {
    const res = await request(app).post("/v1/auth/register").send({
      email: "weak@example.com",
      firstName: "A",
      lastName: "B",
      password: "weakpass",
    });

    expect(res.status).toBe(400);
  });
});

describe("POST /v1/auth/login", () => {
  let userEmail: string;

  beforeEach(async () => {
    userEmail = "login@example.com";
    const user = testDataSource.getRepository(User).create({
      email: userEmail,
      password: await generateHashedPassword(PLAIN_PASSWORD),
      firstName: "Jane",
      lastName: "Doe",
      userRole: UserRole.Talent,
      emailVerified: true,
      active: true,
      tokenVersion: 0,
      roleChangeCount: 0,
    });
    await testDataSource.getRepository(User).save(user);
  });

  it("logs in with correct credentials", async () => {
    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: userEmail, password: PLAIN_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeDefined();
  });

  it("rejects wrong password", async () => {
    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: userEmail, password: "WrongPass1!" });

    expect(res.status).toBe(403);
  });

  it("rejects deactivated account", async () => {
    await testDataSource.getRepository(User).update({ email: userEmail }, { active: false });

    const res = await request(app)
      .post("/v1/auth/login")
      .send({ email: userEmail, password: PLAIN_PASSWORD });

    expect(res.status).toBe(403);
  });
});

describe("POST /v1/auth/forgot-password", () => {
  it("returns generic success for any email (no information leak)", async () => {
    const res = await request(app)
      .post("/v1/auth/forgot-password")
      .send({ email: "anyone@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe(true);
  });
});

describe("POST /v1/auth/logout", () => {
  it("logs out authenticated user and increments tokenVersion", async () => {
    const regRes = await request(app).post("/v1/auth/register").send({
      email: "logout@example.com",
      firstName: "A",
      lastName: "B",
      password: PLAIN_PASSWORD,
    });

    const token: string = regRes.body.data.token;
    const logoutRes = await request(app)
      .post("/v1/auth/logout")
      .set("Authorization", `Bearer ${token}`);

    expect(logoutRes.status).toBe(200);

    // Token should now be invalid (tokenVersion mismatch)
    const meRes = await request(app)
      .get("/v1/user/me")
      .set("Authorization", `Bearer ${token}`);
    expect(meRes.status).toBe(401);
  });
});
