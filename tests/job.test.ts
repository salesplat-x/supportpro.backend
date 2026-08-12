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
import {
  createJob,
  createRole,
  createTalent,
  createApplication,
  createAIConfig,
} from "./helpers/fixtures.js";
import { AIConfig } from "../src/entities/AIConfig.js";
import { TalentEmbedding } from "../src/entities/TalentEmbedding.js";
import { Job } from "../src/entities/Job.js";
import { Organization } from "../src/entities/Organization.js";
import { AiRecommendation } from "../src/entities/AiRecommendation.js";
import { MatchVerdict, MatchRecommendation } from "../src/types/enums.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
  generatePersonalizedQuestions: jest
    .fn()
    .mockResolvedValue({ message: { content: JSON.stringify({ questions: ["Q1", "Q2"] }) } }),
  generateJobContent: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({
        jobBrief: "About the Role: ...\nResponsibilities: ...\nBenefits: ...",
        requirements: "Qualifications: ...\nNice to Have: ...",
        skills: ["TypeScript", "Node.js"],
        goals: ["Ship the new API", "Mentor junior engineers"],
      }),
    },
  }),
  assessTalentFit: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({
        strengths: ["Five years of relevant backend experience per the CV."],
        weaknesses: ["No mention of the specific cloud provider used here."],
      }),
    },
  }),
}));

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
  })),
}));

let app: ReturnType<typeof createApp>;

// Job creation requires the recruiter to have an active company (see
// services/job.ts createJob), so this helper creates one and switches the
// recruiter onto it — mirroring what POST /organizations does for real.
async function createRecruiter(
  opts: { withActiveCompany?: boolean } = {}
): Promise<{ user: User; token: string }> {
  const withActiveCompany = opts.withActiveCompany ?? true;
  const user = testDataSource.getRepository(User).create({
    email: `recruiter_${Date.now()}_${Math.random()}@example.com`,
    password: await generateHashedPassword("Password1!"),
    firstName: "Bob",
    lastName: "Smith",
    userRole: UserRole.Recruiter,
    emailVerified: true,
    active: true,
    tokenVersion: 0,
    roleChangeCount: 0,
  });
  let saved = await testDataSource.getRepository(User).save(user);

  if (withActiveCompany) {
    const org = await testDataSource.getRepository(Organization).save(
      testDataSource.getRepository(Organization).create({
        name: "Test Company",
        email: `company_${Date.now()}_${Math.random()}@example.com`,
        ownerId: saved.id,
      })
    );
    await testDataSource.getRepository(User).update(saved.id, { activeOrganizationId: org.id });
    saved = { ...saved, activeOrganizationId: org.id };
  }

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

  it("rejects job creation when the recruiter has no active company", async () => {
    const { token } = await createRecruiter({ withActiveCompany: false });

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

    expect(res.status).toBe(400);
  });

  it("stamps the created job with the recruiter's active company", async () => {
    const { user: recruiter, token } = await createRecruiter();

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
    expect(res.body.data.job.organizationId).toBe(recruiter.activeOrganizationId);
  });
});

describe("POST /v1/jobs/generate — AI-generated job content", () => {
  it("Recruiter generates job content → 200 with jobBrief, requirements, skills, goals", async () => {
    const { token } = await createRecruiter();

    const res = await request(app)
      .post("/v1/jobs/generate")
      .set("Authorization", `Bearer ${token}`)
      .send({ role: "Software Engineer", experienceLevel: "4-6 years", keywords: ["React"] });

    expect(res.status).toBe(200);
    expect(res.body.data.content.jobBrief).toContain("About the Role");
    expect(res.body.data.content.requirements).toContain("Qualifications");
    expect(res.body.data.content.skills).toEqual(["TypeScript", "Node.js"]);
    expect(res.body.data.content.goals).toEqual(["Ship the new API", "Mentor junior engineers"]);
  });

  it("Missing role → 400", async () => {
    const { token } = await createRecruiter();

    const res = await request(app)
      .post("/v1/jobs/generate")
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("Talent cannot access → 403", async () => {
    const talent = testDataSource.getRepository(User).create({
      email: "talent-generate@example.com",
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
      .post("/v1/jobs/generate")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({ role: "Software Engineer" });

    expect(res.status).toBe(403);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app).post("/v1/jobs/generate").send({ role: "Software Engineer" });
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/jobs/talents/:jobId — top talents enriched with fit evidence", () => {
  it("returns matched talents with LLM-generated strengths/weaknesses", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role, {
      jobEmbedding: `[${new Array(512).fill(0.1).join(",")}]`,
    });
    const aiConfig = await createAIConfig(recruiter);
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });

    const { user: talent } = await createTalent();
    await testDataSource.getRepository(TalentEmbedding).save(
      testDataSource.getRepository(TalentEmbedding).create({
        userId: talent.id,
        cvText: "Five years of backend engineering experience.",
        cvEmbedding: `[${new Array(512).fill(0.1).join(",")}]`,
        generatedAt: new Date(),
      })
    );

    const res = await request(app)
      .get(`/v1/jobs/talents/${job.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const matched = res.body.data.talents.find((t: { id: string }) => t.id === talent.id);
    expect(matched).toBeDefined();
    expect(matched.strengths).toEqual(["Five years of relevant backend experience per the CV."]);
    expect(matched.weaknesses).toEqual(["No mention of the specific cloud provider used here."]);
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

  it("shows the ai_recommendations verdict even when Application.matchVerdict drifted out of sync", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    // Simulates a row that drifted: an AiRecommendation exists but the
    // denormalized Application column was never (or no longer) populated.
    const application = await createApplication(talent, job, { matchVerdict: null });
    await testDataSource.getRepository(AiRecommendation).save(
      testDataSource.getRepository(AiRecommendation).create({
        applicationId: application.id,
        verdict: MatchVerdict.High,
        reasoning: "Strong fit despite the drifted column.",
        recommendation: MatchRecommendation.Hire,
        strengths: ["Great CV match"],
        weaknesses: null,
        risks: null,
      })
    );

    const res = await request(app)
      .get(`/v1/jobs/applications/${job.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const returned = res.body.data.applications.find(
      (a: { id: string }) => a.id === application.id
    );
    expect(returned.matchVerdict).toBe(MatchVerdict.High);
    expect(returned.matchVerdictReasoning).toBe("Strong fit despite the drifted column.");
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/jobs/:_id — update job (Active status requires a linked AI config)
// ---------------------------------------------------------------------------
describe("PATCH /v1/jobs/:_id — update job", () => {
  it("Activating a job with no aiConfigId → 400", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role, { status: JobStatus.Draft });

    const res = await request(app)
      .patch(`/v1/jobs/${job.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "active" });

    expect(res.status).toBe(400);
  });

  it("Activating a job with an aiConfigId → 200", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role, { status: JobStatus.Draft });
    const config = await createAIConfig(recruiter);
    await testDataSource.getRepository(Job).update(job.id, { aiConfigId: config.id });

    const res = await request(app)
      .patch(`/v1/jobs/${job.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "active" });

    expect(res.status).toBe(200);
    expect(res.body.data.job.status).toBe("active");
  });

  it("Non-status updates on a job with no aiConfigId still succeed", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role, { status: JobStatus.Draft });

    const res = await request(app)
      .patch(`/v1/jobs/${job.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ jobBrief: "Updated brief" });

    expect(res.status).toBe(200);
  });
});
