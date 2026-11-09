/**
 * Day 10 (plan feature 5): salary comparison. When a recruiter sets a job's salary,
 * show the low, middle and high pay of similar AuxHR jobs (same role, level and
 * location), converted to the same currency and period; hidden under 5 jobs.
 */
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { createRecruiter, createRole, createJob, createTalent } from "./helpers/fixtures.js";
import type { User } from "../src/entities/User.js";
import type { Role } from "../src/entities/Role.js";
import type { Job } from "../src/entities/Job.js";
import { CompensationPeriod, JobStatus } from "../src/types/enums.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
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

const LAGOS = { locationCity: "Lagos", locationState: "Lagos", locationCountry: "Nigeria" };

async function similarJobs(
  recruiter: User,
  role: Role,
  salaries: [number, number | null][],
  overrides: Partial<Job> = {}
) {
  const jobs: Job[] = [];
  for (const [minSalary, maxSalary] of salaries) {
    jobs.push(
      await createJob(recruiter, role, {
        ...LAGOS,
        experienceLevel: "1-3 years",
        currency: "NGN",
        compensationPeriod: CompensationPeriod.Monthly,
        status: JobStatus.Active,
        minSalary,
        maxSalary,
        ...overrides,
      })
    );
  }
  return jobs;
}

const query = (roleId: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({
    roleId,
    experienceLevel: "1-3 years",
    ...LAGOS,
    currency: "NGN",
    compensationPeriod: "monthly",
    ...extra,
  }).toString();

describe("GET /v1/jobs/salary-comparison (Day 10)", () => {
  afterEach(() => {
    delete process.env["SALARY_FX_RATES"];
  });

  it("gives the low, middle and high pay of 5+ similar AuxHR jobs and how many it used", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    // each job's pay is the middle of its range (or its minimum when there is no maximum)
    await similarJobs(recruiter, role, [
      [100_000, 200_000], // 150k
      [200_000, null], // 200k
      [250_000, 350_000], // 300k
      [300_000, 500_000], // 400k
      [500_000, 700_000], // 600k
    ]);

    const res = await request(app)
      .get(`/v1/jobs/salary-comparison?${query(role.id)}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      available: true,
      count: 5,
      low: 150_000,
      middle: 300_000,
      high: 600_000,
      currency: "NGN",
      compensationPeriod: "monthly",
    });
  });

  it("is hidden when fewer than 5 similar jobs exist", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    await similarJobs(recruiter, role, [
      [100_000, 200_000],
      [100_000, 200_000],
      [100_000, 200_000],
      [100_000, 200_000],
    ]);

    const res = await request(app)
      .get(`/v1/jobs/salary-comparison?${query(role.id)}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ available: false });
  });

  it("only counts jobs with the same role, level and location, leaves out drafts and the job being edited", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const other = await createRole();
    const [editing] = await similarJobs(recruiter, role, [[100_000, 100_000]]);
    await similarJobs(recruiter, role, [
      [100_000, 100_000],
      [100_000, 100_000],
      [100_000, 100_000],
    ]);
    await similarJobs(recruiter, other, [[100_000, 100_000]]);
    await similarJobs(recruiter, role, [[100_000, 100_000]], { experienceLevel: "4-6 years" });
    await similarJobs(recruiter, role, [[100_000, 100_000]], { locationCity: "Abuja" });
    await similarJobs(recruiter, role, [[100_000, 100_000]], { status: JobStatus.Draft });

    const res = await request(app)
      .get(`/v1/jobs/salary-comparison?${query(role.id, { excludeJobId: editing!.id })}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.data).toEqual({ available: false });

    await similarJobs(
      recruiter,
      role,
      [
        [100_000, 100_000],
        [100_000, 100_000],
      ],
      { locationCity: "lagos" }
    );
    const again = await request(app)
      .get(`/v1/jobs/salary-comparison?${query(role.id, { excludeJobId: editing!.id })}`)
      .set("Authorization", `Bearer ${token}`);
    expect(again.body.data).toMatchObject({ available: true, count: 5 });
  });

  it("converts yearly pay to the asked period", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    await similarJobs(recruiter, role, [[1_200_000, 1_200_000]], {
      compensationPeriod: CompensationPeriod.Yearly,
    });
    await similarJobs(recruiter, role, [
      [100_000, 100_000],
      [100_000, 100_000],
      [100_000, 100_000],
      [100_000, 100_000],
    ]);

    const res = await request(app)
      .get(`/v1/jobs/salary-comparison?${query(role.id)}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.data).toMatchObject({ available: true, count: 5, low: 100_000, high: 100_000 });
  });

  it("converts other currencies with the configured rates and skips a currency with no rate", async () => {
    process.env["SALARY_FX_RATES"] = JSON.stringify({ USD: 1, NGN: 1500 });
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    await similarJobs(recruiter, role, [[100, 100]], { currency: "USD" }); // 150,000 NGN
    await similarJobs(recruiter, role, [[100, 100]], { currency: "GBP" }); // no rate: skipped
    await similarJobs(recruiter, role, [
      [100_000, 100_000],
      [100_000, 100_000],
      [100_000, 100_000],
      [100_000, 100_000],
    ]);

    const res = await request(app)
      .get(`/v1/jobs/salary-comparison?${query(role.id)}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.body.data).toMatchObject({ available: true, count: 5, low: 100_000, high: 150_000 });
  });

  it("is for recruiters only and needs the role, level, currency and period", async () => {
    const { token: talentToken } = await createTalent();
    const { token } = await createRecruiter();
    const role = await createRole();

    const asTalent = await request(app)
      .get(`/v1/jobs/salary-comparison?${query(role.id)}`)
      .set("Authorization", `Bearer ${talentToken}`);
    expect(asTalent.status).toBe(403);

    const missing = await request(app)
      .get(`/v1/jobs/salary-comparison?roleId=${role.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(missing.status).toBe(400);
  });
});
