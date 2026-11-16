import request from "supertest";
import type { QueryRunner } from "typeorm";
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
  createJob,
  createRole,
} from "./helpers/fixtures.js";
import { Job } from "../src/entities/Job.js";
import { SavedJob } from "../src/entities/SavedJob.js";
import { JobStatus } from "../src/types/enums.js";
import { apiData } from "./helpers/http.js";
import { CreateSavedJobs1789004500000 } from "../src/migrations/1789004500000-CreateSavedJobs.js";

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

const save = (token: string, jobId: string) =>
  request(app).put(`/v1/jobs/${jobId}/save`).set("Authorization", `Bearer ${token}`);
const unsave = (token: string, jobId: string) =>
  request(app).delete(`/v1/jobs/${jobId}/save`).set("Authorization", `Bearer ${token}`);
const savedRows = (jobId: string) =>
  testDataSource.getRepository(SavedJob).find({ where: { jobId } });

async function setup(status = JobStatus.Active) {
  const { user: recruiter, token: recruiterToken } = await createRecruiter();
  const job = await createJob(recruiter, await createRole("Product Designer"), { status });
  const { user: talent, token } = await createCompleteTalent();
  return { recruiterToken, job, talent, token };
}

describe("PUT /v1/jobs/:jobId/save", () => {
  it("saves an open job once, however many times it's asked", async () => {
    const { job, token } = await setup();

    const results = await Promise.all([
      save(token, job.id),
      save(token, job.id),
      save(token, job.id),
    ]);

    for (const res of results) {
      expect(res.status).toBe(200);
      expect(apiData(res)).toEqual({ saved: true });
    }
    expect(await savedRows(job.id)).toHaveLength(1);
  });

  it.each([JobStatus.Draft, JobStatus.PendingPayment])("a %s job → 404", async (status) => {
    const { job, token } = await setup(status);
    expect((await save(token, job.id)).status).toBe(404);
    expect(await savedRows(job.id)).toHaveLength(0);
  });

  it.each([JobStatus.Closed, JobStatus.Suspended])(
    "a %s job can't be newly saved → 400",
    async (status) => {
      const { job, token } = await setup(status);
      expect((await save(token, job.id)).status).toBe(400);
    }
  );

  it("an unknown job → 404, a bad id → 400, a recruiter → 403", async () => {
    const { job, token, recruiterToken } = await setup();
    expect((await save(token, "8b1d3c3e-1b7a-4a59-9a5c-1f0f8f0e2a11")).status).toBe(404);
    expect((await save(token, "nope")).status).toBe(400);
    expect((await save(recruiterToken, job.id)).status).toBe(403);
  });
});

describe("DELETE /v1/jobs/:jobId/save", () => {
  it("removes a saved job, even once it has closed, and is safe to repeat", async () => {
    const { job, token } = await setup();
    await save(token, job.id);
    await testDataSource.getRepository(Job).update(job.id, { status: JobStatus.Closed });

    const first = await unsave(token, job.id);
    const second = await unsave(token, job.id);

    expect(first.status).toBe(200);
    expect(apiData(first)).toEqual({ saved: false });
    expect(second.status).toBe(200);
    expect(await savedRows(job.id)).toHaveLength(0);
  });
});

describe("isSaved", () => {
  it("is set per talent on the job list and the job page", async () => {
    const { job, token } = await setup();
    const { token: otherToken } = await createCompleteTalent();
    await save(token, job.id);

    const listed = async (auth: string) => {
      const res = await request(app).get("/v1/jobs/").set("Authorization", `Bearer ${auth}`);
      return apiData<{ jobs: Array<{ id: string; isSaved: boolean }> }>(res).jobs.find(
        (item) => item.id === job.id
      )!.isSaved;
    };
    const page = async (auth: string) => {
      const res = await request(app)
        .get(`/v1/jobs/${job.id}`)
        .set("Authorization", `Bearer ${auth}`);
      return apiData<{ job: { isSaved: boolean } }>(res).job.isSaved;
    };

    expect(await listed(token)).toBe(true);
    expect(await listed(otherToken)).toBe(false);
    expect(await page(token)).toBe(true);
    expect(await page(otherToken)).toBe(false);
  });

  it("goes away when the job is deleted", async () => {
    const { job, token } = await setup();
    await save(token, job.id);
    await testDataSource.query(`DELETE FROM "jobs" WHERE id = $1`, [job.id]);
    expect(await savedRows(job.id)).toHaveLength(0);
  });
});

describe("CreateSavedJobs migration", () => {
  it("creates the table with its unique pair and drops it on down", async () => {
    const queries: string[] = [];
    const runner = {
      query: (sql: string) => Promise.resolve(void queries.push(sql)),
    } as unknown as QueryRunner;
    await new CreateSavedJobs1789004500000().up(runner);
    expect(queries[0]).toContain(`CREATE TABLE "saved_jobs"`);
    expect(queries[0]).toContain(`ON DELETE CASCADE`);
    expect(queries[1]).toBe(
      `CREATE UNIQUE INDEX "UQ_saved_jobs_user_job" ON "saved_jobs" ("user_id", "job_id")`
    );
    queries.length = 0;
    await new CreateSavedJobs1789004500000().down(runner);
    expect(queries).toEqual([`DROP TABLE "saved_jobs"`]);
  });
});
