/**
 * Fit report tests — GET /v1/jobs/:jobId/applications/:applicationId/report
 * (single candidate) and POST /v1/jobs/:jobId/applications/report (bulk),
 * the downloadable evidence-based PDF fit report.
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import { startTestDatabase, stopTestDatabase, clearAllTables } from "./helpers/db.js";
import {
  createTalent,
  createRecruiter,
  createRole,
  createJob,
  createApplication,
  createAdmin,
  createAiRecommendation,
  buildMatchAnalysis,
} from "./helpers/fixtures.js";
import { MatchVerdict } from "../src/types/enums.js";

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

// PDF responses are binary — collect raw bytes instead of letting superagent
// try (and fail) to parse them as text/json.
const asPdfBuffer = (req: request.Test) =>
  req.buffer(true).parse((incoming, callback) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => callback(null, Buffer.concat(chunks)));
  });

const expectPdf = (res: request.Response) => {
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toMatch(/application\/pdf/);
  expect(res.headers["content-disposition"]).toMatch(/attachment/);
  expect(Buffer.isBuffer(res.body)).toBe(true);
  expect((res.body as Buffer).length).toBeGreaterThan(100);
  expect((res.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
};

describe("GET /v1/jobs/:jobId/applications/:applicationId/report — single candidate", () => {
  it("returns a downloadable PDF with a sane filename, for a fully-scored candidate", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent({ firstName: "Ada", lastName: "Lovelace" });
    const application = await createApplication(talent, job, {
      matchVerdict: MatchVerdict.High,
      overallFitScore: 88,
    });
    await createAiRecommendation(application);

    const res = await asPdfBuffer(
      request(app)
        .get(`/v1/jobs/${job.id}/applications/${application.id}/report`)
        .set("Authorization", `Bearer ${token}`)
    );

    expectPdf(res);
    expect(res.headers["content-disposition"]).toMatch(/ada-lovelace/i);
  });

  it("still returns a PDF for a candidate with no AI verdict yet (pipeline not finished)", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const application = await createApplication(talent, job); // no verdict at all

    const res = await asPdfBuffer(
      request(app)
        .get(`/v1/jobs/${job.id}/applications/${application.id}/report`)
        .set("Authorization", `Bearer ${token}`)
    );

    expectPdf(res);
  });

  it("lets an Admin download any recruiter's candidate report", async () => {
    const { user: recruiter } = await createRecruiter();
    const { token: adminToken } = await createAdmin();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const application = await createApplication(talent, job);

    const res = await asPdfBuffer(
      request(app)
        .get(`/v1/jobs/${job.id}/applications/${application.id}/report`)
        .set("Authorization", `Bearer ${adminToken}`)
    );

    expect(res.status).toBe(200);
  });

  it("404s for an application that belongs to a different job", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const otherJob = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const foreignApplication = await createApplication(talent, otherJob);

    const res = await request(app)
      .get(`/v1/jobs/${job.id}/applications/${foreignApplication.id}/report`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it("404s for an application that doesn't exist", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    const res = await request(app)
      .get(`/v1/jobs/${job.id}/applications/00000000-0000-4000-8000-000000000000/report`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it("404s for a job that doesn't exist", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .get(
        "/v1/jobs/00000000-0000-4000-8000-000000000000/applications/00000000-0000-4000-8000-000000000001/report"
      )
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("400s for a malformed applicationId", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    const res = await request(app)
      .get(`/v1/jobs/${job.id}/applications/not-a-uuid/report`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
  });

  it("requires auth and ownership", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const application = await createApplication(talent, job);
    const { token: talentToken } = await createTalent();
    const { token: otherRecruiterToken } = await createRecruiter();

    const path = `/v1/jobs/${job.id}/applications/${application.id}/report`;
    expect((await request(app).get(path)).status).toBe(401);
    expect(
      (await request(app).get(path).set("Authorization", `Bearer ${talentToken}`)).status
    ).toBe(403);
    expect(
      (await request(app).get(path).set("Authorization", `Bearer ${otherRecruiterToken}`)).status
    ).toBe(403);
  });
});

describe("POST /v1/jobs/:jobId/applications/report — bulk/shortlisted set", () => {
  it("returns one PDF covering multiple candidates", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talentA } = await createTalent({ firstName: "Ada" });
    const { user: talentB } = await createTalent({ firstName: "Bola" });
    const appA = await createApplication(talentA, job, {
      matchVerdict: MatchVerdict.High,
      overallFitScore: 90,
    });
    const appB = await createApplication(talentB, job, {
      matchVerdict: MatchVerdict.Low,
      overallFitScore: 20,
    });
    await createAiRecommendation(appA, {
      analysis: buildMatchAnalysis({ whyHire: "Strong Kubernetes background." }),
    });
    await createAiRecommendation(appB, {
      verdict: MatchVerdict.Low,
      analysis: buildMatchAnalysis({
        overallFitScore: 20,
        whyHire: "Limited relevant experience.",
      }),
    });

    const res = await asPdfBuffer(
      request(app)
        .post(`/v1/jobs/${job.id}/applications/report`)
        .set("Authorization", `Bearer ${token}`)
        .send({ applicationIds: [appA.id, appB.id] })
    );

    expectPdf(res);
    expect(res.headers["content-disposition"]).toMatch(/2-candidates/);
  });

  it("returns a single-candidate PDF when only one id is given", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const application = await createApplication(talent, job);

    const res = await asPdfBuffer(
      request(app)
        .post(`/v1/jobs/${job.id}/applications/report`)
        .set("Authorization", `Bearer ${token}`)
        .send({ applicationIds: [application.id] })
    );

    expectPdf(res);
  });

  it("silently excludes an applicationId from a different job, still returning a report for the valid ones", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const otherJob = await createJob(recruiter, role);
    const { user: talentOnJob } = await createTalent();
    const { user: talentOnOtherJob } = await createTalent();
    const validApp = await createApplication(talentOnJob, job);
    const foreignApp = await createApplication(talentOnOtherJob, otherJob);

    const res = await asPdfBuffer(
      request(app)
        .post(`/v1/jobs/${job.id}/applications/report`)
        .set("Authorization", `Bearer ${token}`)
        .send({ applicationIds: [validApp.id, foreignApp.id] })
    );

    expectPdf(res);
    expect(res.headers["content-disposition"]).toMatch(/1-candidates/);
  });

  it("404s when none of the given applicationIds belong to the job", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const otherJob = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const foreignApplication = await createApplication(talent, otherJob);

    const res = await request(app)
      .post(`/v1/jobs/${job.id}/applications/report`)
      .set("Authorization", `Bearer ${token}`)
      .send({ applicationIds: [foreignApplication.id] });

    expect(res.status).toBe(404);
  });

  it("400s for an empty applicationIds array", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    const res = await request(app)
      .post(`/v1/jobs/${job.id}/applications/report`)
      .set("Authorization", `Bearer ${token}`)
      .send({ applicationIds: [] });

    expect(res.status).toBe(400);
  });

  it("400s for more than 50 applicationIds", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const tooMany = Array.from({ length: 51 }, (_, i) => {
      const hex = i.toString(16).padStart(12, "0");
      return `00000000-0000-4000-8000-${hex}`;
    });

    const res = await request(app)
      .post(`/v1/jobs/${job.id}/applications/report`)
      .set("Authorization", `Bearer ${token}`)
      .send({ applicationIds: tooMany });

    expect(res.status).toBe(400);
  });

  it("400s for a non-UUID applicationId", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);

    const res = await request(app)
      .post(`/v1/jobs/${job.id}/applications/report`)
      .set("Authorization", `Bearer ${token}`)
      .send({ applicationIds: ["not-a-uuid"] });

    expect(res.status).toBe(400);
  });

  it("requires auth and ownership", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const application = await createApplication(talent, job);
    const { token: talentToken } = await createTalent();
    const { token: otherRecruiterToken } = await createRecruiter();

    const path = `/v1/jobs/${job.id}/applications/report`;
    const body = { applicationIds: [application.id] };
    expect((await request(app).post(path).send(body)).status).toBe(401);
    expect(
      (await request(app).post(path).set("Authorization", `Bearer ${talentToken}`).send(body))
        .status
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(path)
          .set("Authorization", `Bearer ${otherRecruiterToken}`)
          .send(body)
      ).status
    ).toBe(403);
  });
});
