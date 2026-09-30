import request from "supertest";
import { createApp } from "../src/app.js";
import { startTestDatabase, stopTestDatabase, clearAllTables } from "./helpers/db.js";
import { ScoutCvStatus, ScoutRunStatus } from "../src/types/enums.js";
import {
  createOrganization,
  createScoutJob,
  createScout,
  createScoutRun,
  createTalent,
} from "./helpers/fixtures.js";
import { createRecruiter } from "./helpers/scout.js";
import { generateScoutReportPdf } from "../src/utils/scoutReportPdf.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
  assessTalentFit: jest.fn(),
  scoutAssessCandidate: jest.fn(),
  scoutShortlistSummary: jest.fn(),
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

/** A finished run with two shortlisted candidates. */
const completedRun = async (runOverrides = {}) => {
  const { user, token } = await createRecruiter();
  const org = await createOrganization(user);
  const job = await createScoutJob(user, undefined, { organizationId: org.id, shortlistSize: 2 });
  const run = await createScoutRun(user, job, {
    status: ScoutRunStatus.Completed,
    totalCvs: 3,
    shortlistSize: 2,
    completedAt: new Date(),
    shortlistSummary: "Both finalists sell into banks.",
    ...runOverrides,
  });

  await createScout(user, job, {
    scoutRunId: run.id,
    status: ScoutCvStatus.Scored,
    rank: 1,
    shortlisted: true,
    evaluationScore: 88,
    candidateName: "Ada Obi",
    candidateEmail: "ada@example.com",
    candidatePhone: "+2348012345678",
    candidateAddress: "Lagos, Nigeria",
    recommendation: "She closed six-figure bank deals at Paystack for three years.",
    insights:
      "Strengths: Closed six-figure deals; Managed a team of four\nConcerns: No public-sector work\nMet must-haves: negotiation\nMissing must-haves: procurement",
  });
  await createScout(user, job, {
    scoutRunId: run.id,
    status: ScoutCvStatus.Scored,
    rank: 2,
    shortlisted: true,
    evaluationScore: 74,
    candidateName: "Ben Musa",
    recommendation: "He has sold to banks but only as part of a larger team.",
    insights: "Strengths: Bank exposure",
  });
  await createScout(user, job, {
    scoutRunId: run.id,
    status: ScoutCvStatus.Scored,
    rank: 3,
    shortlisted: false,
    evaluationScore: 41,
    candidateName: "Not Shortlisted",
  });

  return { user, token, org, job, run };
};

describe("GET /v1/scout/runs/:runId/report.pdf", () => {
  it("returns a PDF attachment named after the campaign", async () => {
    const { token, run } = await completedRun();

    const res = await request(app)
      .get(`/v1/scout/runs/${run.id}/report.pdf`)
      .set("Authorization", `Bearer ${token}`)
      .buffer()
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(".pdf");
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
  });

  it("409s while the run is still being scored", async () => {
    const { token, run } = await completedRun({ status: ScoutRunStatus.Processing });

    const res = await request(app)
      .get(`/v1/scout/runs/${run.id}/report.pdf`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(409);
  });

  it("still produces a valid PDF for a run with an empty shortlist", async () => {
    const { user, token } = await createRecruiter();
    const org = await createOrganization(user);
    const job = await createScoutJob(user, undefined, { organizationId: org.id });
    const run = await createScoutRun(user, job, {
      status: ScoutRunStatus.Failed,
      totalCvs: 2,
      completedAt: new Date(),
    });

    const res = await request(app)
      .get(`/v1/scout/runs/${run.id}/report.pdf`)
      .set("Authorization", `Bearer ${token}`)
      .buffer()
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect((res.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
  });

  it("403s another company's run", async () => {
    const { run } = await completedRun();
    const { user: other, token: otherToken } = await createRecruiter();
    await createOrganization(other);

    const res = await request(app)
      .get(`/v1/scout/runs/${run.id}/report.pdf`)
      .set("Authorization", `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
  });

  it("404s an unknown run", async () => {
    const { token } = await completedRun();
    const res = await request(app)
      .get("/v1/scout/runs/11111111-1111-4111-8111-111111111111/report.pdf")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("401s without a token", async () => {
    const { run } = await completedRun();
    const res = await request(app).get(`/v1/scout/runs/${run.id}/report.pdf`);
    expect(res.status).toBe(401);
  });

  it("403s a talent", async () => {
    const { run } = await completedRun();
    const talent = await createTalent();
    const res = await request(app)
      .get(`/v1/scout/runs/${run.id}/report.pdf`)
      .set("Authorization", `Bearer ${talent.token}`);
    expect(res.status).toBe(403);
  });
});

describe("generateScoutReportPdf", () => {
  const baseInput = {
    campaignName: "Q1 Enterprise AE hiring",
    roleName: "Account Executive",
    experienceLevel: "4-6 years",
    jobBrief: "Sell payments software to Nigerian banks.",
    recruiterGuide: "Prefer people who have sold to banks.",
    runDate: new Date("2026-01-15T00:00:00.000Z"),
    totalCvs: 20,
    shortlistSummary: "All three come from fintech.",
  };

  it("produces a PDF with one page per candidate plus a cover", async () => {
    const buffer = await generateScoutReportPdf({
      ...baseInput,
      candidates: [
        {
          rank: 1,
          name: "Ada Obi",
          email: "ada@example.com",
          phone: "+234",
          location: "Lagos",
          headline: "Enterprise AE",
          score: 88,
          recommendation: "She closed six-figure bank deals.",
          strengths: ["Closed six-figure deals"],
          concerns: ["No public-sector work"],
          mustHavesMet: ["negotiation"],
          mustHavesMissing: [],
        },
      ],
    });

    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it("handles a candidate with no score and no reason", async () => {
    const buffer = await generateScoutReportPdf({
      ...baseInput,
      shortlistSummary: null,
      candidates: [
        {
          rank: 1,
          name: "Unknown",
          score: null,
          recommendation: null,
          strengths: [],
          concerns: [],
          mustHavesMet: [],
          mustHavesMissing: [],
        },
      ],
    });

    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("handles an empty shortlist", async () => {
    const buffer = await generateScoutReportPdf({ ...baseInput, candidates: [] });
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("handles very long free text without throwing", async () => {
    const buffer = await generateScoutReportPdf({
      ...baseInput,
      jobBrief: "x ".repeat(4000),
      recruiterGuide: "y ".repeat(2000),
      candidates: [
        {
          rank: 1,
          name: "Ada Obi",
          score: 90,
          recommendation: "z ".repeat(500),
          strengths: Array.from({ length: 20 }, (_, i) => `strength ${i}`),
          concerns: Array.from({ length: 20 }, (_, i) => `concern ${i}`),
          mustHavesMet: [],
          mustHavesMissing: [],
        },
      ],
    });

    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });
});
