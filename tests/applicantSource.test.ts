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
  createRole,
  createJob,
  createTalent,
  createAIConfig,
  createApplication,
} from "./helpers/fixtures.js";
import { Application } from "../src/entities/Application.js";
import { Job } from "../src/entities/Job.js";
import { AddSourceToApplications1789002950000 } from "../src/migrations/1789002950000-AddSourceToApplications.js";

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

type ApplicantList = {
  data: { applications: { source: string | null; talentId: string }[] };
};

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

async function openJob() {
  const { user: recruiter, token } = await createRecruiter();
  const role = await createRole();
  const job = await createJob(recruiter, role);
  const aiConfig = await createAIConfig(recruiter, { minPrescreeningScore: 60 });
  await testDataSource.getRepository(Job).update(job.id, { aiConfigId: aiConfig.id });
  return { recruiter, token, job };
}

async function applyWith(jobId: string, body: Record<string, unknown>) {
  const { user: talent, token } = await createTalent({
    prescreeningScore: 75,
    cvFileName: "cv.pdf",
  });
  const res = await request(app)
    .patch(`/v1/jobs/applications/${jobId}`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
  return { res, talent };
}

describe("PATCH /v1/jobs/applications/:jobId saves the applicant source", () => {
  it("saves the source the candidate's link carried", async () => {
    const { job } = await openJob();
    const { res, talent } = await applyWith(job.id, { source: "whatsapp" });
    expect(res.status).toBeLessThan(300);
    const saved = await testDataSource
      .getRepository(Application)
      .findOneByOrFail({ jobId: job.id, talentId: talent.id });
    expect(saved.source).toBe("whatsapp");
  });

  it("trims and lower-cases it, so WhatsApp and whatsapp count as one source", async () => {
    const { job } = await openJob();
    const { talent } = await applyWith(job.id, { source: "  WhatsApp " });
    const saved = await testDataSource
      .getRepository(Application)
      .findOneByOrFail({ jobId: job.id, talentId: talent.id });
    expect(saved.source).toBe("whatsapp");
  });

  it("leaves the source empty when the link had none", async () => {
    const { job } = await openJob();
    const { talent } = await applyWith(job.id, {});
    const saved = await testDataSource
      .getRepository(Application)
      .findOneByOrFail({ jobId: job.id, talentId: talent.id });
    expect(saved.source).toBeNull();
  });

  it("refuses a source that is not text or is longer than 50 characters", async () => {
    const { job } = await openJob();
    expect((await applyWith(job.id, { source: "x".repeat(51) })).res.status).toBe(400);
    expect((await applyWith(job.id, { source: 12 })).res.status).toBe(400);
  });
});

describe("GET /v1/jobs/applications/:jobId returns and filters by source", () => {
  it("returns each applicant's source and filters the list by ?source=", async () => {
    const { token, job } = await openJob();
    const { user: a } = await createTalent();
    const { user: b } = await createTalent();
    const { user: c } = await createTalent();
    await createApplication(a, job, { source: "whatsapp" });
    await createApplication(b, job, { source: "linkedin" });
    await createApplication(c, job);

    const all = await request(app)
      .get(`/v1/jobs/applications/${job.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(all.status).toBe(200);
    const allBody = all.body as ApplicantList;
    const sources = allBody.data.applications.map((x) => x.source);
    expect(sources.sort()).toEqual(["linkedin", "whatsapp", null].sort());

    const filtered = await request(app)
      .get(`/v1/jobs/applications/${job.id}?source=WhatsApp`)
      .set("Authorization", `Bearer ${token}`);
    expect(filtered.status).toBe(200);
    const filteredBody = filtered.body as ApplicantList;
    expect(filteredBody.data.applications).toHaveLength(1);
    expect(filteredBody.data.applications[0]!.talentId).toBe(a.id);
  });
});

describe("AddSourceToApplications migration", () => {
  it("adds a nullable source column and drops it on down", async () => {
    const queries: string[] = [];
    const runner = {
      query: jest.fn(async (q: string) => queries.push(q)),
    } as unknown as QueryRunner;
    await new AddSourceToApplications1789002950000().up(runner);
    expect(queries[0]).toMatch(/ALTER TABLE "applications" ADD "source" character varying\(50\)/);
    expect(queries[0]).not.toMatch(/NOT NULL/);
    await new AddSourceToApplications1789002950000().down(runner);
    expect(queries[1]).toMatch(/ALTER TABLE "applications" DROP COLUMN "source"/);
  });
});
