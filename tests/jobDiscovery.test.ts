import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import {
  createRecruiter,
  createCompleteTalent,
  createAIConfig,
  createJob,
  createRole,
} from "./helpers/fixtures.js";
import { Job } from "../src/entities/Job.js";
import { CompensationPeriod, EmploymentType, JobStatus } from "../src/types/enums.js";
import { apiData } from "./helpers/http.js";
import { screeningPlan } from "../src/services/screeningPlan.js";
import { staffSizeRange } from "../src/services/job.js";
import { Organization } from "../src/entities/Organization.js";
import { createStaff } from "./helpers/staff.js";
import { setupCompany } from "./helpers/company.js";
import type { AIConfig } from "../src/entities/AIConfig.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
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
});

type ListedJob = { id: string; role: { name: string } };

const list = async (query: Record<string, string | number>) => {
  const res = await request(app).get("/v1/jobs/").query(query);
  expect(res.status).toBe(200);
  return apiData<{ jobs: ListedJob[]; total: number }>(res);
};

const names = (jobs: ListedJob[]) => jobs.map((job) => job.role.name).sort();

describe("GET /v1/jobs/ — totals and talent filters", () => {
  it("returns the total across pages and only active jobs", async () => {
    const { user: recruiter } = await createRecruiter();
    for (let i = 0; i < 5; i++) await createJob(recruiter, await createRole(`Role ${i}`));
    await createJob(recruiter, await createRole("Closed"), { status: JobStatus.Closed });

    const page = await list({ limit: 2, offset: 0 });

    expect(page.jobs).toHaveLength(2);
    expect(page.total).toBe(5);
  });

  it("filters by top monthly pay in one currency, converting yearly pay", async () => {
    const { user: recruiter } = await createRecruiter();
    const make = async (name: string, overrides: Partial<Job>) =>
      createJob(recruiter, await createRole(name), overrides);
    await make("Monthly above", {
      currency: "NGN",
      minSalary: 250000,
      maxSalary: 300000,
      compensationPeriod: CompensationPeriod.Monthly,
    });
    await make("Monthly below", {
      currency: "NGN",
      minSalary: 200000,
      maxSalary: 299999,
      compensationPeriod: CompensationPeriod.Monthly,
    });
    await make("Yearly above", {
      currency: "NGN",
      minSalary: 3000000,
      maxSalary: 3600000,
      compensationPeriod: CompensationPeriod.Yearly,
    });
    await make("Yearly below", {
      currency: "NGN",
      minSalary: 3000000,
      maxSalary: 3500000,
      compensationPeriod: CompensationPeriod.Yearly,
    });
    await make("Dollars", {
      currency: "USD",
      minSalary: 500000,
      maxSalary: 900000,
      compensationPeriod: CompensationPeriod.Monthly,
    });
    await make("No currency", {
      currency: null,
      minSalary: 500000,
      maxSalary: 900000,
      compensationPeriod: CompensationPeriod.Monthly,
    });

    const result = await list({ minMonthlySalary: 300000 });

    expect(names(result.jobs)).toEqual(["Monthly above", "Yearly above"]);
    expect(result.total).toBe(2);
    expect(names((await list({ minMonthlySalary: 300000, currency: "USD" })).jobs)).toEqual([
      "Dollars",
    ]);
  });

  it("filters to jobs posted in the last 7 days", async () => {
    const { user: recruiter } = await createRecruiter();
    await createJob(recruiter, await createRole("New"));
    const old = await createJob(recruiter, await createRole("Old"));
    await testDataSource.query(
      `UPDATE "jobs" SET "createdAt" = NOW() - INTERVAL '8 days' WHERE id = $1`,
      [old.id]
    );

    expect(names((await list({ postedWithin: "week" })).jobs)).toEqual(["New"]);
  });

  it("filters by employment type", async () => {
    const { user: recruiter } = await createRecruiter();
    await createJob(recruiter, await createRole("Full"), {
      employmentType: EmploymentType.FullTime,
    });
    await createJob(recruiter, await createRole("Part"), {
      employmentType: EmploymentType.PartTime,
    });

    expect(names((await list({ employmentType: "full_time" })).jobs)).toEqual(["Full"]);
  });

  it.each([
    ["a negative minimum pay", { minMonthlySalary: -1 }],
    ["a fractional minimum pay", { minMonthlySalary: "1.5" }],
    ["an unknown currency", { minMonthlySalary: 1, currency: "EUR" }],
    ["an unknown posted window", { postedWithin: "month" }],
  ])("rejects %s → 400", async (_label, query) => {
    expect((await request(app).get("/v1/jobs/").query(query)).status).toBe(400);
  });
});

describe("GET /v1/jobs/:_id — screening plan", () => {
  const config = (overrides: Partial<AIConfig>) =>
    ({
      prescreeningAssessment: true,
      cvSimilarity: true,
      personalizedAssessment: false,
      noPersonalizedQuestions: 0,
      problemSolvingAssessment: true,
      noOfProblemSolvingQuestions: 8,
      cultureFitAssessment: true,
      noOfCultureFitQuestions: 5,
      personalityEvaluation: false,
      noOfEIQuestions: null,
      noOfSNQuestions: null,
      noOfTFQuestions: null,
      noOfJPQuestions: null,
      uploadedQuestions: null,
      aiInterview: true,
      aiInterviewMode: "audio",
      ...overrides,
    }) as AIConfig;

  it("lists each timed step in order with its questions and minutes", () => {
    expect(screeningPlan(config({}))).toEqual([
      { key: "skills_test", questionCount: null, minutes: 10 },
      { key: "problem_solving", questionCount: 8, minutes: 11 },
      { key: "culture_fit", questionCount: 5, minutes: 6 },
      { key: "ai_interview", questionCount: 5, minutes: 15 },
    ]);
  });

  it("counts every personality question, including uploaded ones, and skips empty steps", () => {
    const plan = screeningPlan(
      config({
        personalizedAssessment: true,
        noPersonalizedQuestions: 0,
        personalityEvaluation: true,
        noOfEIQuestions: 2,
        noOfSNQuestions: 2,
        noOfTFQuestions: 2,
        noOfJPQuestions: 1,
        uploadedQuestions: ["One more?", "  "],
        aiInterview: false,
      })
    );
    expect(plan.map((step) => step.key)).toEqual([
      "skills_test",
      "problem_solving",
      "culture_fit",
      "personality",
    ]);
    expect(plan[3]).toEqual({ key: "personality", questionCount: 8, minutes: 6 });
  });

  it("is sent with the job to talents and visitors, without any pass mark", async () => {
    const { user: recruiter } = await createRecruiter();
    const aiConfig = await createAIConfig(recruiter, {
      minPrescreeningScore: 77,
      minCvSimilarityScore: 66,
      problemSolvingAssessment: true,
      noOfProblemSolvingQuestions: 4,
    });
    const job = await createJob(recruiter, await createRole(), { aiConfigId: aiConfig.id });
    const { token } = await createCompleteTalent();

    for (const auth of [{}, { Authorization: `Bearer ${token}` }]) {
      const res = await request(app).get(`/v1/jobs/${job.id}`).set(auth);
      expect(res.status).toBe(200);
      const { job: body } = apiData<{ job: { screening: Array<{ key: string }> } }>(res);
      expect(body.screening.map((step) => step.key)).toContain("problem_solving");
      const text = JSON.stringify(res.body);
      expect(text).not.toContain("minPrescreeningScore");
      expect(text).not.toContain("minCvSimilarityScore");
    }
  });
});

describe("GET /v1/jobs/:_id — about the company", () => {
  it("bucketes the company's active staff into a size range", () => {
    expect(staffSizeRange(0)).toBeNull();
    expect(staffSizeRange(1)).toBe("1–10");
    expect(staffSizeRange(51)).toBe("51–200");
    expect(staffSizeRange(200)).toBe("51–200");
    expect(staffSizeRange(501)).toBe("500+");
  });

  it("sends the company's mission and size range with the job", async () => {
    const { owner, org } = await setupCompany();
    const organizationId = org.id;
    await testDataSource
      .getRepository(Organization)
      .update(organizationId, { mission: "Payment tools for small shops" });
    const job = await createJob(owner.user, await createRole(), { organizationId });
    await createStaff(app, owner.token, organizationId);

    const res = await request(app).get(`/v1/jobs/${job.id}`);

    expect(apiData<{ job: { company: unknown } }>(res).job.company).toEqual({
      mission: "Payment tools for small shops",
      staffSize: "1–10",
    });
  });
});
