import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { Scout } from "../src/entities/Scout.js";
import { ScoutJob } from "../src/entities/ScoutJob.js";
import { ScoutRun } from "../src/entities/ScoutRun.js";
import { ExperienceLevel, WorkMode } from "../src/types/enums.js";
import {
  createRole,
  createOrganization,
  createScoutJob,
  createScout,
  createScoutRun,
} from "./helpers/fixtures.js";
import { createRecruiter } from "./helpers/scout.js";
import { apiData } from "./helpers/http.js";

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
  jest.clearAllMocks();
});

const validCampaign = (roleId: string) => ({
  role: roleId,
  name: "Q1 Enterprise AE hiring",
  jobBrief:
    "We need an enterprise account executive to sell our payments platform to Nigerian banks and close six-figure annual contracts.",
  recruiterGuide:
    "Prioritise people who have sold to banks. Skip anyone whose only experience is at an agency.",
});

describe("POST /v1/scout/jobs — campaign creation", () => {
  it("stores every targeting field and defaults the shortlist size", async () => {
    const { user, token } = await createRecruiter();
    await createOrganization(user);
    const role = await createRole();

    const res = await request(app)
      .post("/v1/scout/jobs/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        ...validCampaign(role.id),
        experienceLevel: ExperienceLevel.FourToSix,
        mustHaveSkills: ["enterprise sales", "negotiation"],
        niceToHaveSkills: ["salesforce"],
        workMode: WorkMode.Hybrid,
        locationCountry: "Nigeria",
        locationState: "Lagos",
        locationCity: "Ikeja",
      });

    expect(res.status).toBe(201);
    const { scoutJob } = apiData<{ scoutJob: ScoutJob }>(res);
    expect(scoutJob.roleId).toBe(role.id);
    expect(scoutJob.shortlistSize).toBe(5);
    expect(scoutJob.experienceLevel).toBe(ExperienceLevel.FourToSix);
    expect(scoutJob.mustHaveSkills).toEqual(["enterprise sales", "negotiation"]);
    expect(scoutJob.niceToHaveSkills).toEqual(["salesforce"]);
    expect(scoutJob.workMode).toBe(WorkMode.Hybrid);
    expect(scoutJob.locationCity).toBe("Ikeja");
  });

  it("requires an active company before a campaign can be created", async () => {
    const { token } = await createRecruiter();
    const role = await createRole();

    const res = await request(app)
      .post("/v1/scout/jobs/")
      .set("Authorization", `Bearer ${token}`)
      .send(validCampaign(role.id));

    expect(res.status).toBe(400);
  });

  it("404s when the role does not exist", async () => {
    const { user, token } = await createRecruiter();
    await createOrganization(user);

    const res = await request(app)
      .post("/v1/scout/jobs/")
      .set("Authorization", `Bearer ${token}`)
      .send(validCampaign("11111111-1111-4111-8111-111111111111"));

    expect(res.status).toBe(404);
  });

  it("rejects an unauthenticated request", async () => {
    const res = await request(app).post("/v1/scout/jobs/").send({});
    expect(res.status).toBe(401);
  });
});

describe("shortlistSize boundaries", () => {
  const cases: Array<{ label: string; value: unknown; expected: number }> = [
    { label: "below the minimum", value: 1, expected: 400 },
    { label: "at the minimum", value: 2, expected: 201 },
    { label: "at the maximum", value: 10, expected: 201 },
    { label: "above the maximum", value: 11, expected: 400 },
    { label: "a fraction", value: 5.5, expected: 400 },
    { label: "not a number", value: "abc", expected: 400 },
    { label: "zero", value: 0, expected: 400 },
    { label: "negative", value: -3, expected: 400 },
  ];

  for (const { label, value, expected } of cases) {
    it(`${expected === 201 ? "accepts" : "rejects"} a shortlist size that is ${label}`, async () => {
      const { user, token } = await createRecruiter();
      await createOrganization(user);
      const role = await createRole();

      const res = await request(app)
        .post("/v1/scout/jobs/")
        .set("Authorization", `Bearer ${token}`)
        .send({ ...validCampaign(role.id), shortlistSize: value });

      expect(res.status).toBe(expected);
      if (expected === 201) {
        const { scoutJob } = apiData<{ scoutJob: ScoutJob }>(res);
        expect(scoutJob.shortlistSize).toBe(value);
      }
    });
  }
});

describe("campaign field validation", () => {
  it("rejects a job brief that is too short to match against", async () => {
    const { user, token } = await createRecruiter();
    await createOrganization(user);
    const role = await createRole();

    const res = await request(app)
      .post("/v1/scout/jobs/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...validCampaign(role.id), jobBrief: "Need a salesperson" });

    expect(res.status).toBe(400);
  });

  it("rejects AI instructions that are too short", async () => {
    const { user, token } = await createRecruiter();
    await createOrganization(user);
    const role = await createRole();

    const res = await request(app)
      .post("/v1/scout/jobs/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...validCampaign(role.id), recruiterGuide: "Pick good ones" });

    expect(res.status).toBe(400);
  });

  it("rejects a name over 150 characters", async () => {
    const { user, token } = await createRecruiter();
    await createOrganization(user);
    const role = await createRole();

    const res = await request(app)
      .post("/v1/scout/jobs/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...validCampaign(role.id), name: "x".repeat(151) });

    expect(res.status).toBe(400);
  });

  it("rejects more than 15 must-have skills", async () => {
    const { user, token } = await createRecruiter();
    await createOrganization(user);
    const role = await createRole();

    const res = await request(app)
      .post("/v1/scout/jobs/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        ...validCampaign(role.id),
        mustHaveSkills: Array.from({ length: 16 }, (_, i) => `skill-${i}`),
      });

    expect(res.status).toBe(400);
  });

  it("rejects a skills array containing a blank entry", async () => {
    const { user, token } = await createRecruiter();
    await createOrganization(user);
    const role = await createRole();

    const res = await request(app)
      .post("/v1/scout/jobs/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...validCampaign(role.id), mustHaveSkills: ["negotiation", "   "] });

    expect(res.status).toBe(400);
  });

  it("rejects an unknown experience level", async () => {
    const { user, token } = await createRecruiter();
    await createOrganization(user);
    const role = await createRole();

    const res = await request(app)
      .post("/v1/scout/jobs/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...validCampaign(role.id), experienceLevel: "ancient" });

    expect(res.status).toBe(400);
  });
});

describe("PUT /v1/scout/jobs/:_id", () => {
  it("updates targeting fields", async () => {
    const { user, token } = await createRecruiter();
    const org = await createOrganization(user);
    const job = await createScoutJob(user, undefined, { organizationId: org.id });

    const res = await request(app)
      .put(`/v1/scout/jobs/${job.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ shortlistSize: 8, mustHaveSkills: ["python"] });

    expect(res.status).toBe(200);
    const { scoutJob } = apiData<{ scoutJob: ScoutJob }>(res);
    expect(scoutJob.shortlistSize).toBe(8);
    expect(scoutJob.mustHaveSkills).toEqual(["python"]);
  });

  it("rejects an out-of-range shortlist size on update", async () => {
    const { user, token } = await createRecruiter();
    const org = await createOrganization(user);
    const job = await createScoutJob(user, undefined, { organizationId: org.id });

    const res = await request(app)
      .put(`/v1/scout/jobs/${job.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ shortlistSize: 99 });

    expect(res.status).toBe(400);
  });

  it("403s when the campaign belongs to another company", async () => {
    const { user: owner } = await createRecruiter();
    const ownerOrg = await createOrganization(owner);
    const job = await createScoutJob(owner, undefined, { organizationId: ownerOrg.id });

    const { user: other, token: otherToken } = await createRecruiter();
    await createOrganization(other);

    const res = await request(app)
      .put(`/v1/scout/jobs/${job.id}`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ name: "Hijacked" });

    expect(res.status).toBe(403);
  });
});

describe("DELETE /v1/scout/jobs/:_id", () => {
  it("removes the campaign along with its runs and scored CVs", async () => {
    const { user, token } = await createRecruiter();
    const org = await createOrganization(user);
    const job = await createScoutJob(user, undefined, { organizationId: org.id });
    const run = await createScoutRun(user, job);
    await createScout(user, job, { scoutRunId: run.id });

    const res = await request(app)
      .delete(`/v1/scout/jobs/${job.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(await testDataSource.getRepository(ScoutJob).count()).toBe(0);
    expect(await testDataSource.getRepository(ScoutRun).count()).toBe(0);
    expect(await testDataSource.getRepository(Scout).count()).toBe(0);
  });

  it("403s when deleting another company's campaign", async () => {
    const { user: owner } = await createRecruiter();
    const ownerOrg = await createOrganization(owner);
    const job = await createScoutJob(owner, undefined, { organizationId: ownerOrg.id });

    const { user: other, token: otherToken } = await createRecruiter();
    await createOrganization(other);

    const res = await request(app)
      .delete(`/v1/scout/jobs/${job.id}`)
      .set("Authorization", `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
  });
});

describe("GET /v1/scout/jobs — list aggregates", () => {
  it("returns per-campaign rollups and a total for pagination", async () => {
    const { user, token } = await createRecruiter();
    const org = await createOrganization(user);
    const job = await createScoutJob(user, undefined, { organizationId: org.id });
    const run = await createScoutRun(user, job);
    await createScout(user, job, { scoutRunId: run.id, evaluationScore: 62 });
    await createScout(user, job, { scoutRunId: run.id, evaluationScore: 91 });

    const res = await request(app).get("/v1/scout/jobs").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const body = apiData<{
      scoutJobs: Array<{ id: string; cvsScanned: number; bestScore: number; runCount: number }>;
      total: number;
    }>(res);
    expect(body.total).toBe(1);
    expect(body.scoutJobs[0]!.cvsScanned).toBe(2);
    expect(body.scoutJobs[0]!.bestScore).toBe(91);
    expect(body.scoutJobs[0]!.runCount).toBe(1);
  });

  it("reports zeroes for a campaign that has never been run", async () => {
    const { user, token } = await createRecruiter();
    const org = await createOrganization(user);
    await createScoutJob(user, undefined, { organizationId: org.id });

    const res = await request(app).get("/v1/scout/jobs").set("Authorization", `Bearer ${token}`);

    const body = apiData<{
      scoutJobs: Array<{ cvsScanned: number; bestScore: number | null; runCount: number }>;
    }>(res);
    expect(body.scoutJobs[0]!.cvsScanned).toBe(0);
    expect(body.scoutJobs[0]!.bestScore).toBeNull();
    expect(body.scoutJobs[0]!.runCount).toBe(0);
  });

  it("only lists campaigns belonging to the active company", async () => {
    const { user: other } = await createRecruiter();
    const otherOrg = await createOrganization(other);
    await createScoutJob(other, undefined, { organizationId: otherOrg.id });

    const { user, token } = await createRecruiter();
    const org = await createOrganization(user);
    await createScoutJob(user, undefined, { organizationId: org.id, name: "Mine" });

    const res = await request(app).get("/v1/scout/jobs").set("Authorization", `Bearer ${token}`);

    const body = apiData<{ scoutJobs: Array<{ name: string }>; total: number }>(res);
    expect(body.total).toBe(1);
    expect(body.scoutJobs[0]!.name).toBe("Mine");
  });

  it("returns an empty list when the recruiter has no active company", async () => {
    const { token } = await createRecruiter();

    const res = await request(app).get("/v1/scout/jobs").set("Authorization", `Bearer ${token}`);

    const body = apiData<{ scoutJobs: unknown[]; total: number }>(res);
    expect(body.scoutJobs).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("filters by a search term across campaign and role name", async () => {
    const { user, token } = await createRecruiter();
    const org = await createOrganization(user);
    await createScoutJob(user, undefined, { organizationId: org.id, name: "Lagos AE push" });
    await createScoutJob(user, undefined, { organizationId: org.id, name: "Backend hiring" });

    const res = await request(app)
      .get("/v1/scout/jobs?search=lagos")
      .set("Authorization", `Bearer ${token}`);

    const body = apiData<{ scoutJobs: Array<{ name: string }>; total: number }>(res);
    expect(body.total).toBe(1);
    expect(body.scoutJobs[0]!.name).toBe("Lagos AE push");
  });
});
