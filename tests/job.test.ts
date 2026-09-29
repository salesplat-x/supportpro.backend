import request from "supertest";
import { In } from "typeorm";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { User } from "../src/entities/User.js";
import { DEFAULT_BILLING_PLAN_KEY, JobStatus, UserRole } from "../src/types/enums.js";
import { generateHashedPassword, signToken } from "../src/utils/crypto.js";
import {
  createJob,
  createRole,
  createTalent,
  createApplication,
  createAIConfig,
  createAdmin,
} from "./helpers/fixtures.js";
import { AIConfig } from "../src/entities/AIConfig.js";
import { TalentEmbedding } from "../src/entities/TalentEmbedding.js";
import { Job } from "../src/entities/Job.js";
import { Organization } from "../src/entities/Organization.js";
import { AiRecommendation } from "../src/entities/AiRecommendation.js";
import { Application } from "../src/entities/Application.js";
import {
  MatchVerdict,
  MatchRecommendation,
  MatchVerdictStatus,
  ScreeningStage,
} from "../src/types/enums.js";
import {
  generateJobContent,
  generateJobField,
  assessApplicationMatch,
} from "../src/utils/integrations/openai.js";

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
  generateJobField: jest.fn().mockResolvedValue({
    message: { content: JSON.stringify({ text: "A shorter brief." }) },
  }),
  assessTalentFit: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({
        strengths: ["Five years of relevant backend experience per the CV."],
        weaknesses: ["No mention of the specific cloud provider used here."],
      }),
    },
  }),
  assessApplicationMatch: jest.fn().mockResolvedValue({
    message: {
      content: JSON.stringify({
        verdict: "high",
        recommendation: "hire",
        reasoning: "Strong fit based on retried evidence.",
        strengths: ["Relevant CV experience"],
        weaknesses: [],
        risks: [],
        overallFitScore: 80,
      }),
    },
  }),
}));

const mockGenerateJobContent = generateJobContent as jest.Mock;
const mockGenerateJobField = generateJobField as jest.Mock;
const mockAssessApplicationMatch = assessApplicationMatch as jest.Mock;

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
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
    emailVerifiedAt: new Date(),
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
    expect(res.body.data.job.locationCountry).toBeNull();
  });

  it("creates a remote job without location → 201", async () => {
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
        workMode: ["remote"],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.job.locationCountry).toBeNull();
    expect(res.body.data.job.locationState).toBeNull();
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
        workMode: ["hybrid"],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.job.locationCountry).toBe("Nigeria");
    expect(res.body.data.job.locationState).toBeNull();
  });

  it("rejects hybrid job creation without country", async () => {
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
        workMode: ["hybrid"],
      });

    expect(res.status).toBe(400);
  });

  it("rejects job creation without a recruiter role", async () => {
    const talent = testDataSource.getRepository(User).create({
      email: "talent@example.com",
      password: await generateHashedPassword("Password1!"),
      firstName: "Jane",
      lastName: "Doe",
      userRole: UserRole.Talent,
      emailVerifiedAt: new Date(),
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

  describe("server-owned fields cannot be set by the client", () => {
    const jobBody = {
      role: "software-engineer",
      jobBrief: "Looking for a great engineer",
      experienceLevel: "4-6 years",
      maxSalary: 100000,
      minSalary: 50000,
      compensationPeriod: "yearly",
      workMode: ["remote"],
    };

    it.each(["active", "pending_payment", "closed"])(
      "a client-supplied status of %s is ignored — the job is created as a draft",
      async (status) => {
        const { user: recruiter, token } = await createRecruiter();
        const config = await createAIConfig(recruiter);

        const res = await request(app)
          .post("/v1/jobs/")
          .set("Authorization", `Bearer ${token}`)
          .send({ ...jobBody, status, aiConfigId: config.id });

        expect(res.status).toBe(201);
        expect(res.body.data.job.status).toBe(JobStatus.Draft);
        const stored = await testDataSource
          .getRepository(Job)
          .findOne({ where: { id: res.body.data.job.id } });
        expect(stored!.status).toBe(JobStatus.Draft);
      }
    );

    it("a pay_per_use org cannot get a live job without paying by posting status: active", async () => {
      const { user: recruiter, token } = await createRecruiter();
      const config = await createAIConfig(recruiter);

      await request(app)
        .post("/v1/jobs/")
        .set("Authorization", `Bearer ${token}`)
        .send({ ...jobBody, status: "active", aiConfigId: config.id })
        .expect(201);

      const live = await testDataSource.getRepository(Job).count({
        where: { organizationId: recruiter.activeOrganizationId!, status: JobStatus.Active },
      });
      expect(live).toBe(0);
    });

    it("a client-supplied organizationId and postedById are ignored", async () => {
      const { user: recruiter, token } = await createRecruiter();
      const { user: other } = await createRecruiter();

      const res = await request(app)
        .post("/v1/jobs/")
        .set("Authorization", `Bearer ${token}`)
        .send({
          ...jobBody,
          organizationId: other.activeOrganizationId,
          postedById: other.id,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.job.organizationId).toBe(recruiter.activeOrganizationId);
      expect(res.body.data.job.postedById).toBe(recruiter.id);
    });
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

  it("No role, description or existing job description → 400", async () => {
    const { token } = await createRecruiter();

    const res = await request(app)
      .post("/v1/jobs/generate")
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("Free-text description → 200 with every job field extracted and invalid values dropped", async () => {
    const { token } = await createRecruiter();
    mockGenerateJobContent.mockResolvedValueOnce({
      message: {
        content: JSON.stringify({
          role: "Backend Engineer",
          experienceLevel: "4-6 years",
          workMode: ["hybrid", "on the moon"],
          locationCountry: "Nigeria",
          locationState: "Lagos",
          locationCity: null,
          currency: "JPY",
          minSalary: 800000,
          maxSalary: 500000,
          compensationPeriod: "monthly",
          jobBrief: "About the Role: ...",
          requirements: "Qualifications: ...",
          skills: ["Go", 42, ""],
          goals: ["Ship payments v2"],
        }),
      },
    });

    const res = await request(app)
      .post("/v1/jobs/generate")
      .set("Authorization", `Bearer ${token}`)
      .send({ prompt: "Backend engineer, hybrid in Lagos, fintech, 800k a month" });

    expect(res.status).toBe(200);
    expect(mockGenerateJobContent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: "Backend engineer, hybrid in Lagos, fintech, 800k a month",
      })
    );
    expect(res.body.data.content).toEqual({
      role: "Backend Engineer",
      experienceLevel: "4-6 years",
      workMode: ["hybrid"],
      locationCountry: "Nigeria",
      locationState: "Lagos",
      locationCity: null,
      currency: null,
      minSalary: 800000,
      maxSalary: null,
      compensationPeriod: "monthly",
      jobBrief: "About the Role: ...",
      requirements: "Qualifications: ...",
      skills: ["Go"],
      goals: ["Ship payments v2"],
    });
  });

  it("Keeps the role the recruiter picked over the AI's guess", async () => {
    const { token } = await createRecruiter();
    mockGenerateJobContent.mockResolvedValueOnce({
      message: { content: JSON.stringify({ role: "Software Developer", jobBrief: "..." }) },
    });

    const res = await request(app)
      .post("/v1/jobs/generate")
      .set("Authorization", `Bearer ${token}`)
      .send({ role: "Software Engineer" });

    expect(res.status).toBe(200);
    expect(res.body.data.content.role).toBe("Software Engineer");
  });

  it("Unreadable AI response → 400 instead of a crash", async () => {
    const { token } = await createRecruiter();
    mockGenerateJobContent.mockResolvedValueOnce({ message: { content: "not json" } });

    const res = await request(app)
      .post("/v1/jobs/generate")
      .set("Authorization", `Bearer ${token}`)
      .send({ role: "Software Engineer" });

    expect(res.status).toBe(400);
  });

  it("Talent cannot access → 403", async () => {
    const talent = testDataSource.getRepository(User).create({
      email: "talent-generate@example.com",
      password: await generateHashedPassword("Password1!"),
      firstName: "Jane",
      lastName: "Doe",
      userRole: UserRole.Talent,
      emailVerifiedAt: new Date(),
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

describe("POST /v1/jobs/generate/file — job draft from an uploaded job description", () => {
  it("Text file → 200 and its contents are sent to the AI as the source", async () => {
    const { token } = await createRecruiter();

    const res = await request(app)
      .post("/v1/jobs/generate/file")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("We are hiring a Product Designer in Abuja."), {
        filename: "jd.txt",
        contentType: "text/plain",
      });

    expect(res.status).toBe(200);
    expect(mockGenerateJobContent).toHaveBeenLastCalledWith({
      sourceText: "We are hiring a Product Designer in Abuja.",
    });
    expect(res.body.data.content.jobBrief).toContain("About the Role");
  });

  it("Unsupported file type → 400", async () => {
    const { token } = await createRecruiter();

    const res = await request(app)
      .post("/v1/jobs/generate/file")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("fake"), { filename: "jd.png", contentType: "image/png" });

    expect(res.status).toBe(400);
  });

  it("No file → 400", async () => {
    const { token } = await createRecruiter();

    const res = await request(app)
      .post("/v1/jobs/generate/file")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
  });
});

describe("POST /v1/jobs/generate/field — AI help for a single job field", () => {
  it("Text field rewrite → 200 with the new text", async () => {
    const { token } = await createRecruiter();

    const res = await request(app)
      .post("/v1/jobs/generate/field")
      .set("Authorization", `Bearer ${token}`)
      .send({
        field: "jobBrief",
        action: "shorter",
        currentText: "A very long brief.",
        job: { role: "Backend Engineer" },
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ text: "A shorter brief." });
  });

  it("Skill suggestions → 200 without skills the job already has", async () => {
    const { token } = await createRecruiter();
    mockGenerateJobField.mockResolvedValueOnce({
      message: { content: JSON.stringify({ items: ["Go", "PostgreSQL", "go", "Kafka"] }) },
    });

    const res = await request(app)
      .post("/v1/jobs/generate/field")
      .set("Authorization", `Bearer ${token}`)
      .send({ field: "skills", job: { role: "Backend Engineer", skills: ["Go"] } });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ suggestions: ["PostgreSQL", "Kafka"] });
  });

  it("Unknown field → 400", async () => {
    const { token } = await createRecruiter();

    const res = await request(app)
      .post("/v1/jobs/generate/field")
      .set("Authorization", `Bearer ${token}`)
      .send({ field: "salary", job: { role: "Backend Engineer" } });

    expect(res.status).toBe(400);
  });

  it("Nothing to work from → 400", async () => {
    const { token } = await createRecruiter();

    const res = await request(app)
      .post("/v1/jobs/generate/field")
      .set("Authorization", `Bearer ${token}`)
      .send({ field: "jobBrief" });

    expect(res.status).toBe(400);
  });

  it("Talent cannot access → 403", async () => {
    const { token: talentToken } = await createTalent({ email: "talent-field@example.com" });

    const res = await request(app)
      .post("/v1/jobs/generate/field")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({ field: "jobBrief", job: { role: "Backend Engineer" } });

    expect(res.status).toBe(403);
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

  it("lets an Admin view any recruiter's job applications for the Company > Jobs > Candidates drill-down", async () => {
    const { user: recruiter } = await createRecruiter();
    const { token: adminToken } = await createAdmin();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    await createApplication(talent, job);

    const res = await request(app)
      .get(`/v1/jobs/applications/${job.id}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.applications.length).toBeGreaterThan(0);
  });

  it("includes the talent's cvUrl so the recruiter can view the CV in a new tab", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    await testDataSource.getRepository(User).update(talent.id, {
      cvUrl: "https://salesplat.nyc3.digitaloceanspaces.com/cvs/talent-id/some-uuid.pdf",
    });
    await createApplication(talent, job);

    const res = await request(app)
      .get(`/v1/jobs/applications/${job.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const application = res.body.data.applications[0];
    expect(application.talent.cvUrl).toBe(
      "https://salesplat.nyc3.digitaloceanspaces.com/cvs/talent-id/some-uuid.pdf"
    );
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

  it("requires auth and blocks a talent/admin-of-another-org from a recruiter's applicant list", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { token: talentToken } = await createTalent();
    const { user: otherRecruiter, token: otherToken } = await createRecruiter();
    expect(otherRecruiter).toBeDefined();

    expect((await request(app).get(`/v1/jobs/applications/${job.id}`)).status).toBe(401);
    expect(
      (
        await request(app)
          .get(`/v1/jobs/applications/${job.id}`)
          .set("Authorization", `Bearer ${talentToken}`)
      ).status
    ).toBe(403);
    expect(
      (
        await request(app)
          .get(`/v1/jobs/applications/${job.id}`)
          .set("Authorization", `Bearer ${otherToken}`)
      ).status
    ).toBe(403);
  });

  it("404s for a job that doesn't exist", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .get("/v1/jobs/applications/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/jobs/applications/:jobId — default sort is best AI match first (item: AI Match column fix)", () => {
  it("orders high > medium > low > no-verdict, tie-broken by overallFitScore desc, still-screening applicants last", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    const low = await createApplication((await createTalent()).user, job, {
      currentStage: ScreeningStage.Completed,
      matchVerdict: MatchVerdict.Low,
      overallFitScore: 30,
    });
    const highLower = await createApplication((await createTalent()).user, job, {
      currentStage: ScreeningStage.Completed,
      matchVerdict: MatchVerdict.High,
      overallFitScore: 70,
    });
    const highHigher = await createApplication((await createTalent()).user, job, {
      currentStage: ScreeningStage.Completed,
      matchVerdict: MatchVerdict.High,
      overallFitScore: 95,
    });
    const stillScreening = await createApplication((await createTalent()).user, job, {
      currentStage: ScreeningStage.Personalized,
      matchVerdict: null,
    });
    const medium = await createApplication((await createTalent()).user, job, {
      currentStage: ScreeningStage.Completed,
      matchVerdict: MatchVerdict.Medium,
      overallFitScore: 60,
    });
    // Completed but the verdict generation failed outright — no verdict, but
    // still "further along" than one still mid-screening, per verdictRank.
    const failedVerdict = await createApplication((await createTalent()).user, job, {
      currentStage: ScreeningStage.Completed,
      matchVerdict: null,
      matchVerdictStatus: MatchVerdictStatus.Failed,
    });

    const res = await request(app)
      .get(`/v1/jobs/applications/${job.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const ids = res.body.data.applications.map((a: { id: string }) => a.id);
    expect(ids).toEqual([
      highHigher.id,
      highLower.id,
      medium.id,
      low.id,
      failedVerdict.id,
      stillScreening.id,
    ]);
  });

  it("sort=dateApplied orders by most recently applied, ignoring AI match entirely", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    const older = await createApplication((await createTalent()).user, job, {
      matchVerdict: MatchVerdict.High,
      overallFitScore: 99,
    });
    await testDataSource
      .getRepository(Application)
      .update(older.id, { createdAt: new Date(Date.now() - 60_000) });
    const newer = await createApplication((await createTalent()).user, job, {
      matchVerdict: MatchVerdict.Low,
      overallFitScore: 10,
    });

    const res = await request(app)
      .get(`/v1/jobs/applications/${job.id}?sort=dateApplied`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.applications.map((a: { id: string }) => a.id)).toEqual([
      newer.id,
      older.id,
    ]);
  });

  it("sort=cvSimilarity keeps the legacy CV-score-first ordering", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    const lowCv = await createApplication((await createTalent()).user, job, {
      cvSimilarityScore: 40,
      matchVerdict: MatchVerdict.High, // deliberately the opposite of AI-match order
      overallFitScore: 99,
    });
    const highCv = await createApplication((await createTalent()).user, job, {
      cvSimilarityScore: 90,
      matchVerdict: MatchVerdict.Low,
      overallFitScore: 10,
    });

    const res = await request(app)
      .get(`/v1/jobs/applications/${job.id}?sort=cvSimilarity`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.data.applications.map((a: { id: string }) => a.id)).toEqual([
      highCv.id,
      lowCv.id,
    ]);
  });

  it("minMatchScore filters out applicants below the given overallFitScore", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const belowBar = await createApplication((await createTalent()).user, job, {
      overallFitScore: 40,
    });
    const atBar = await createApplication((await createTalent()).user, job, {
      overallFitScore: 60,
    });
    const aboveBar = await createApplication((await createTalent()).user, job, {
      overallFitScore: 85,
    });
    expect(belowBar).toBeDefined();

    const res = await request(app)
      .get(`/v1/jobs/applications/${job.id}?minMatchScore=60`)
      .set("Authorization", `Bearer ${token}`);

    const ids = res.body.data.applications.map((a: { id: string }) => a.id).sort();
    expect(ids).toEqual([atBar.id, aboveBar.id].sort());
  });

  it("matchVerdict filters to only that verdict", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    await createApplication((await createTalent()).user, job, { matchVerdict: MatchVerdict.High });
    const medium = await createApplication((await createTalent()).user, job, {
      matchVerdict: MatchVerdict.Medium,
    });
    await createApplication((await createTalent()).user, job, { matchVerdict: MatchVerdict.Low });

    const res = await request(app)
      .get(`/v1/jobs/applications/${job.id}?matchVerdict=medium`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.data.applications.map((a: { id: string }) => a.id)).toEqual([medium.id]);
  });

  it.each([
    ["an unknown sort value", "sort=nonsense"],
    ["an unknown matchVerdict", "matchVerdict=excellent"],
    ["a minMatchScore below 0", "minMatchScore=-1"],
    ["a minMatchScore above 100", "minMatchScore=101"],
    ["a limit of 0", "limit=0"],
    ["a limit above 200", "limit=201"],
  ])("400s for %s", async (_label, query) => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    const res = await request(app)
      .get(`/v1/jobs/applications/${job.id}?${query}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  it("accepts the boundary values 1 and 200 for limit", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    await createApplication((await createTalent()).user, job);

    expect(
      (
        await request(app)
          .get(`/v1/jobs/applications/${job.id}?limit=1`)
          .set("Authorization", `Bearer ${token}`)
      ).status
    ).toBe(200);
    expect(
      (
        await request(app)
          .get(`/v1/jobs/applications/${job.id}?limit=200`)
          .set("Authorization", `Bearer ${token}`)
      ).status
    ).toBe(200);
  });
});

describe("POST /v1/jobs/:jobId/retry-verdicts", () => {
  it("retries both never-processed (null) and explicitly failed verdicts, not just missing ones", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    const { user: neverProcessedTalent } = await createTalent();
    const neverProcessed = await createApplication(neverProcessedTalent, job, {
      currentStage: ScreeningStage.Completed,
      matchVerdict: null,
      matchVerdictStatus: MatchVerdictStatus.Pending,
    });

    const { user: failedTalent } = await createTalent();
    const failed = await createApplication(failedTalent, job, {
      currentStage: ScreeningStage.Completed,
      matchVerdict: null,
      matchVerdictStatus: MatchVerdictStatus.Failed,
      matchVerdictAttempts: 5,
    });

    const { user: succeededTalent } = await createTalent();
    await createApplication(succeededTalent, job, {
      currentStage: ScreeningStage.Completed,
      matchVerdict: MatchVerdict.High,
      matchVerdictStatus: MatchVerdictStatus.Succeeded,
    });

    const res = await request(app)
      .post(`/v1/jobs/${job.id}/retry-verdicts`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.attempted).toBe(2);

    const refetched = await testDataSource
      .getRepository(Application)
      .find({ where: { id: In([neverProcessed.id, failed.id]) } });
    expect(refetched.every((a) => a.matchVerdict === MatchVerdict.High)).toBe(true);
  });

  it("with applicationIds, retries only the given candidate — a per-row 'Regenerate' click", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const target = await createApplication((await createTalent()).user, job, {
      currentStage: ScreeningStage.Completed,
      matchVerdict: null,
    });
    const untouched = await createApplication((await createTalent()).user, job, {
      currentStage: ScreeningStage.Completed,
      matchVerdict: null,
    });

    const res = await request(app)
      .post(`/v1/jobs/${job.id}/retry-verdicts`)
      .set("Authorization", `Bearer ${token}`)
      .send({ applicationIds: [target.id] });

    expect(res.status).toBe(200);
    expect(res.body.data.attempted).toBe(1);
    const [targetRow, untouchedRow] = await testDataSource
      .getRepository(Application)
      .find({ where: { id: In([target.id, untouched.id]) } });
    expect([targetRow, untouchedRow].find((a) => a?.id === target.id)?.matchVerdict).toBe(
      MatchVerdict.High
    );
    expect([targetRow, untouchedRow].find((a) => a?.id === untouched.id)?.matchVerdict).toBeNull();
  });

  it("an explicit empty applicationIds array retries nothing — distinct from omitting the field", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const application = await createApplication((await createTalent()).user, job, {
      currentStage: ScreeningStage.Completed,
      matchVerdict: null,
    });

    const res = await request(app)
      .post(`/v1/jobs/${job.id}/retry-verdicts`)
      .set("Authorization", `Bearer ${token}`)
      .send({ applicationIds: [] });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    const reloaded = await testDataSource
      .getRepository(Application)
      .findOne({ where: { id: application.id } });
    expect(reloaded?.matchVerdict).toBeNull();
  });

  it("ignores an applicationId that belongs to a different job", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const jobA = await createJob(recruiter, role);
    const jobB = await createJob(recruiter, role);
    const foreignApplication = await createApplication((await createTalent()).user, jobB, {
      currentStage: ScreeningStage.Completed,
      matchVerdict: null,
    });

    const res = await request(app)
      .post(`/v1/jobs/${jobA.id}/retry-verdicts`)
      .set("Authorization", `Bearer ${token}`)
      .send({ applicationIds: [foreignApplication.id] });

    expect(res.status).toBe(200);
    expect(res.body.data.attempted).toBe(0);
    const reloaded = await testDataSource
      .getRepository(Application)
      .findOne({ where: { id: foreignApplication.id } });
    expect(reloaded?.matchVerdict).toBeNull();
    expect(mockAssessApplicationMatch).not.toHaveBeenCalled();
  });

  it("ignores an applicationId that already has a succeeded verdict — recommendations are generated once", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const succeeded = await createApplication((await createTalent()).user, job, {
      currentStage: ScreeningStage.Completed,
      matchVerdict: MatchVerdict.Low,
      matchVerdictStatus: MatchVerdictStatus.Succeeded,
      matchVerdictReasoning: "Original reasoning",
    });

    const res = await request(app)
      .post(`/v1/jobs/${job.id}/retry-verdicts`)
      .set("Authorization", `Bearer ${token}`)
      .send({ applicationIds: [succeeded.id] });

    expect(res.status).toBe(200);
    expect(res.body.data.attempted).toBe(0);
    const reloaded = await testDataSource
      .getRepository(Application)
      .findOne({ where: { id: succeeded.id } });
    expect(reloaded?.matchVerdict).toBe(MatchVerdict.Low);
    expect(reloaded?.matchVerdictReasoning).toBe("Original reasoning");
  });

  it("400s for a non-UUID entry in applicationIds", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    const res = await request(app)
      .post(`/v1/jobs/${job.id}/retry-verdicts`)
      .set("Authorization", `Bearer ${token}`)
      .send({ applicationIds: ["not-a-uuid"] });

    expect(res.status).toBe(400);
  });

  it("requires auth and ownership", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { token: talentToken } = await createTalent();
    const { token: otherRecruiterToken } = await createRecruiter();

    expect((await request(app).post(`/v1/jobs/${job.id}/retry-verdicts`)).status).toBe(401);
    expect(
      (
        await request(app)
          .post(`/v1/jobs/${job.id}/retry-verdicts`)
          .set("Authorization", `Bearer ${talentToken}`)
      ).status
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/v1/jobs/${job.id}/retry-verdicts`)
          .set("Authorization", `Bearer ${otherRecruiterToken}`)
      ).status
    ).toBe(403);
  });

  it("404s for a job that doesn't exist", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/jobs/00000000-0000-0000-0000-000000000000/retry-verdicts")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
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

  it("PATCH cannot move a job to another company or poster", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const { user: other } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role, {
      status: JobStatus.Draft,
      organizationId: recruiter.activeOrganizationId,
    });

    const res = await request(app)
      .patch(`/v1/jobs/${job.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        jobBrief: "Updated brief",
        organizationId: other.activeOrganizationId,
        postedById: other.id,
      });

    expect(res.status).toBe(200);
    const stored = await testDataSource.getRepository(Job).findOne({ where: { id: job.id } });
    expect(stored!.jobBrief).toBe("Updated brief");
    expect(stored!.organizationId).toBe(recruiter.activeOrganizationId);
    expect(stored!.postedById).toBe(recruiter.id);
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

// ---------------------------------------------------------------------------
// PATCH /v1/jobs/:_id — plan gating on activation (see services/entitlements.ts,
// services/job.ts updateJob). Activating a job is the only place job_listings gating
// is actually enforced today — see also tests/entitlements.test.ts for direct
// unit coverage of the underlying assertWithinLimit logic.
// ---------------------------------------------------------------------------
describe("PATCH /v1/jobs/:_id — plan gating on activation", () => {
  async function setOrgPlan(recruiter: User, billingPlan: string): Promise<string> {
    const orgId = recruiter.activeOrganizationId!;
    await testDataSource.getRepository(Organization).update(orgId, { billingPlan });
    return orgId;
  }

  async function fillListings(recruiter: User, orgId: string, count: number) {
    const role = await createRole();
    const config = await createAIConfig(recruiter);
    const active: Job[] = [];
    for (let i = 0; i < count; i += 1) {
      active.push(
        await createJob(recruiter, role, {
          organizationId: orgId,
          status: JobStatus.Active,
          aiConfigId: config.id,
        })
      );
    }
    const draft = await createJob(recruiter, role, {
      organizationId: orgId,
      status: JobStatus.Draft,
      aiConfigId: config.id,
    });
    return { active, draft };
  }

  const countActive = (orgId: string) =>
    testDataSource
      .getRepository(Job)
      .count({ where: { organizationId: orgId, status: JobStatus.Active } });

  it("sme_basic org at its job_listings limit (2 active) → a 3rd activation overflows to pay-per-use instead of 402", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const orgId = await setOrgPlan(recruiter, "sme_basic");
    const { draft } = await fillListings(recruiter, orgId, 2);

    const res = await request(app)
      .patch(`/v1/jobs/${draft.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "active" });

    expect(res.status).toBe(200);
    expect(res.body.data.job.status).toBe("pending_payment");
    expect(await countActive(orgId)).toBe(2);

    // Overflowing a single job never takes the subscription away.
    const org = await testDataSource.getRepository(Organization).findOne({ where: { id: orgId } });
    expect(org!.billingPlan).toBe("sme_basic");
  });

  it("an org somehow over its limit also overflows rather than going live", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const orgId = await setOrgPlan(recruiter, "sme_basic");
    const { draft } = await fillListings(recruiter, orgId, 3);

    const res = await request(app)
      .patch(`/v1/jobs/${draft.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "active" });

    expect(res.body.data.job.status).toBe("pending_payment");
    expect(await countActive(orgId)).toBe(3);
  });

  it("once a listing slot frees up, activation goes live on the plan again", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const orgId = await setOrgPlan(recruiter, "sme_basic");
    const { active, draft } = await fillListings(recruiter, orgId, 2);

    await request(app)
      .patch(`/v1/jobs/${active[0]!.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "closed" })
      .expect(200);

    const res = await request(app)
      .patch(`/v1/jobs/${draft.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "active" });

    expect(res.status).toBe(200);
    expect(res.body.data.job.status).toBe("active");
  });

  it("an unlimited plan never overflows", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const orgId = await setOrgPlan(recruiter, "enterprise");
    const { draft } = await fillListings(recruiter, orgId, 40);

    const res = await request(app)
      .patch(`/v1/jobs/${draft.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "active" });

    expect(res.body.data.job.status).toBe("active");
  });

  it("each plan's limit is enforced at its own number (pro: 10)", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const orgId = await setOrgPlan(recruiter, "pro");
    const { draft } = await fillListings(recruiter, orgId, 9);

    const tenth = await request(app)
      .patch(`/v1/jobs/${draft.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "active" });
    expect(tenth.body.data.job.status).toBe("active");

    const { draft: eleventh } = await fillListings(recruiter, orgId, 0);
    const res = await request(app)
      .patch(`/v1/jobs/${eleventh.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "active" });
    expect(res.body.data.job.status).toBe("pending_payment");
  });

  it("sme_basic org under its limit (1 active) → activating a 2nd → 200", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const orgId = await setOrgPlan(recruiter, "sme_basic");
    const role = await createRole();
    const config = await createAIConfig(recruiter);

    await createJob(recruiter, role, {
      organizationId: orgId,
      status: JobStatus.Active,
      aiConfigId: config.id,
    });
    const draft = await createJob(recruiter, role, {
      organizationId: orgId,
      status: JobStatus.Draft,
      aiConfigId: config.id,
    });

    const res = await request(app)
      .patch(`/v1/jobs/${draft.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "active" });

    expect(res.status).toBe(200);
  });

  it("Re-saving an already-Active job doesn't re-check the limit (no double counting)", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const orgId = await setOrgPlan(recruiter, "sme_basic");
    const role = await createRole();
    const config = await createAIConfig(recruiter);

    // Org already at the limit purely from other jobs.
    await createJob(recruiter, role, {
      organizationId: orgId,
      status: JobStatus.Active,
      aiConfigId: config.id,
    });
    const alreadyActive = await createJob(recruiter, role, {
      organizationId: orgId,
      status: JobStatus.Active,
      aiConfigId: config.id,
    });

    const res = await request(app)
      .patch(`/v1/jobs/${alreadyActive.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "active", jobBrief: "Tweaked brief" });

    expect(res.status).toBe(200);
  });

  it("pay_per_use org: activation defers to PendingPayment instead of being counted against a limit", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const orgId = await setOrgPlan(recruiter, "pay_per_use");
    const role = await createRole();
    const config = await createAIConfig(recruiter);
    const draft = await createJob(recruiter, role, {
      organizationId: orgId,
      status: JobStatus.Draft,
      aiConfigId: config.id,
    });

    const res = await request(app)
      .patch(`/v1/jobs/${draft.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "active" });

    expect(res.status).toBe(200);
    expect(res.body.data.job.status).toBe("pending_payment");
  });

  // Brand-new organizations default to pay_per_use, so activation can never quietly go
  // live for free the way it did under the old "free" default (which had no catalogue
  // entry, and therefore no gating at all).
  it("a brand-new org defaults to pay_per_use, so every activation needs payment", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const orgId = recruiter.activeOrganizationId!;
    const role = await createRole();
    const config = await createAIConfig(recruiter);

    const org = await testDataSource.getRepository(Organization).findOne({ where: { id: orgId } });
    expect(org!.billingPlan).toBe(DEFAULT_BILLING_PLAN_KEY);

    for (let i = 0; i < 3; i += 1) {
      const draft = await createJob(recruiter, role, {
        organizationId: orgId,
        status: JobStatus.Draft,
        aiConfigId: config.id,
      });
      const res = await request(app)
        .patch(`/v1/jobs/${draft.id}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "active" });
      expect(res.status).toBe(200);
      expect(res.body.data.job.status).toBe("pending_payment");
    }

    const active = await testDataSource
      .getRepository(Job)
      .count({ where: { organizationId: orgId, status: JobStatus.Active } });
    expect(active).toBe(0);
  });

  it("Job with no organizationId skips gating entirely (pre-tenancy data)", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const config = await createAIConfig(recruiter);
    const draft = await createJob(recruiter, role, {
      organizationId: null,
      status: JobStatus.Draft,
      aiConfigId: config.id,
      postedById: recruiter.id,
    });

    const res = await request(app)
      .patch(`/v1/jobs/${draft.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "active" });

    expect(res.status).toBe(200);
  });
});
