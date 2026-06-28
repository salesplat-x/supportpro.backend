import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { User } from "../src/entities/User.js";
import { UserRole } from "../src/types/enums.js";
import { generateHashedPassword, signToken } from "../src/utils/crypto.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
  generatePersonalizedQuestions: jest
    .fn()
    .mockResolvedValue({ message: { content: JSON.stringify({ questions: ["Q1", "Q2"] }) } }),
}));

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
  })),
}));

let app: ReturnType<typeof createApp>;
let recruiterToken: string;

async function createRecruiter(): Promise<{ user: User; token: string }> {
  const user = testDataSource.getRepository(User).create({
    email: "recruiter@example.com",
    password: await generateHashedPassword("Password1!"),
    firstName: "Bob",
    lastName: "Smith",
    userRole: UserRole.Recruiter,
    emailVerified: true,
    active: true,
    tokenVersion: 0,
    roleChangeCount: 0,
  });
  const saved = await testDataSource.getRepository(User).save(user);
  return { user: saved, token: signToken(saved) };
}

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

describe("POST /v1/jobs/", () => {
  it("creates a job with auto-created role", async () => {
    const { token } = await createRecruiter();

    const res = await request(app)
      .post("/v1/jobs/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        role: "software-engineer",
        jobBrief: "Looking for a great engineer",
        experienceLevel: "4-6 years",
        maxSalary: 100000,
        minSalary: 50000,
        locationState: "Lagos",
        locationCountry: "Nigeria",
        workMode: ["remote"],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.job.jobBrief).toBe("Looking for a great engineer");
  });

  it("rejects job creation without a recruiter role", async () => {
    const talent = testDataSource.getRepository(User).create({
      email: "talent@example.com",
      password: await generateHashedPassword("Password1!"),
      firstName: "Jane",
      lastName: "Doe",
      userRole: UserRole.Talent,
      emailVerified: true,
      active: true,
      tokenVersion: 0,
      roleChangeCount: 0,
    });
    const savedTalent = await testDataSource.getRepository(User).save(talent);
    const talentToken = signToken(savedTalent);

    const res = await request(app)
      .post("/v1/jobs/")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({
        role: "software-engineer",
        jobBrief: "Test job",
        experienceLevel: "1-3 years",
        maxSalary: 50000,
        minSalary: 20000,
        locationState: "Lagos",
        locationCountry: "Nigeria",
        workMode: ["remote"],
      });

    expect(res.status).toBe(403);
  });
});

describe("GET /v1/jobs/", () => {
  it("returns active jobs without authentication", async () => {
    const res = await request(app).get("/v1/jobs/");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.jobs)).toBe(true);
  });
});

describe("Job salary validation", () => {
  it("rejects job where minSalary >= maxSalary", async () => {
    const { token } = await createRecruiter();

    const res = await request(app)
      .post("/v1/jobs/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        role: "engineer",
        jobBrief: "Test",
        experienceLevel: "1-3 years",
        maxSalary: 50000,
        minSalary: 60000,
        locationState: "Lagos",
        locationCountry: "Nigeria",
        workMode: ["remote"],
      });

    expect(res.status).toBe(400);
  });
});
