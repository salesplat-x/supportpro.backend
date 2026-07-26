import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { User } from "../src/entities/User.js";
import { JobStatus, UserRole } from "../src/types/enums.js";
import { generateHashedPassword, signToken } from "../src/utils/crypto.js";
import { createJob, createRole, createTalent, createApplication } from "./helpers/fixtures.js";

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
        compensationPeriod: "yearly",
        locationState: "Lagos",
        locationCountry: "Nigeria",
        workMode: ["remote"],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.job.jobBrief).toBe("Looking for a great engineer");
  });

  it("creates a job with only Country (no State/City) → 201", async () => {
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
        compensationPeriod: "yearly",
        locationCountry: "Nigeria",
        workMode: ["remote"],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.job.locationCountry).toBe("Nigeria");
    expect(res.body.data.job.locationState).toBeNull();
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
        compensationPeriod: "yearly",
        locationState: "Lagos",
        locationCountry: "Nigeria",
        workMode: ["remote"],
      });

    expect(res.status).toBe(400);
  });

  it("creates a job without maxSalary (optional) → 201", async () => {
    const { token } = await createRecruiter();

    const res = await request(app)
      .post("/v1/jobs/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        role: "engineer",
        jobBrief: "Test",
        experienceLevel: "1-3 years",
        minSalary: 60000,
        compensationPeriod: "monthly",
        locationState: "Lagos",
        locationCountry: "Nigeria",
        workMode: ["remote"],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.job.maxSalary).toBeNull();
    expect(res.body.data.job.compensationPeriod).toBe("monthly");
  });

  it("rejects job creation without compensationPeriod", async () => {
    const { token } = await createRecruiter();

    const res = await request(app)
      .post("/v1/jobs/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        role: "engineer",
        jobBrief: "Test",
        experienceLevel: "1-3 years",
        minSalary: 60000,
        locationState: "Lagos",
        locationCountry: "Nigeria",
        workMode: ["remote"],
      });

    expect(res.status).toBe(400);
  });
});

describe("GET /v1/jobs/:_id anonymous access scoping", () => {
  it("returns 404 for a Draft job when unauthenticated", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role, { status: JobStatus.Draft });

    const res = await request(app).get(`/v1/jobs/${job.id}`);

    expect(res.status).toBe(404);
  });

  it("returns 404 for a Closed job when unauthenticated", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role, { status: JobStatus.Closed });

    const res = await request(app).get(`/v1/jobs/${job.id}`);

    expect(res.status).toBe(404);
  });

  it("returns 200 for an Active job when unauthenticated", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role, { status: JobStatus.Active });

    const res = await request(app).get(`/v1/jobs/${job.id}`);

    expect(res.status).toBe(200);
    expect(res.body.data.job.id).toBe(job.id);
  });

  it("returns a Draft job when authenticated as its owning recruiter", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role, { status: JobStatus.Draft });

    const res = await request(app)
      .get(`/v1/jobs/${job.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.job.id).toBe(job.id);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/jobs/applications/:jobId — item 6: the recruiter's "View Application"
// link was built from a field the API never returns (`application.job`),
// producing a `.../singleJobPost/undefined/<id>` URL. The real scalar `jobId`
// column is always present — assert it's actually there.
// ---------------------------------------------------------------------------
describe("GET /v1/jobs/applications/:jobId — applicant list includes jobId", () => {
  it("each returned application includes its jobId scalar", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    await createApplication(talent, job);

    const res = await request(app)
      .get(`/v1/jobs/applications/${job.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const applications = res.body.data.applications;
    expect(applications.length).toBeGreaterThan(0);
    expect(applications.every((a: { jobId: string }) => a.jobId === job.id)).toBe(true);
  });
});
