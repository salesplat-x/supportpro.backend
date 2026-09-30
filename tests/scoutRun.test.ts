import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { Scout } from "../src/entities/Scout.js";
import { ScoutRun } from "../src/entities/ScoutRun.js";
import { ScoutCandidate } from "../src/entities/ScoutCandidate.js";
import { Organization } from "../src/entities/Organization.js";
import { ScoutCvStatus, ScoutRunStatus } from "../src/types/enums.js";
import { MAX_BATCH_SIZE, MAX_CV_CHARS } from "../src/config/scout.js";
import { MAX_DURABLE_ATTEMPTS } from "../src/utils/durableJobs.js";
import { createOrganization, createScoutJob, createTalent } from "./helpers/fixtures.js";
import { createRecruiter, assessmentResponse, assessmentPayload } from "./helpers/scout.js";
import { apiData } from "./helpers/http.js";
import * as scoutRunService from "../src/services/scoutRun.js";

// jest.mock factories are hoisted above every const in this file, so the mocks are
// created inside the factories and read back with requireMock.
jest.mock("../src/utils/integrations/spaces.js", () => ({
  uploadPrivateToSpaces: jest.fn(),
  getFromSpaces: jest.fn(),
  uploadToSpaces: jest.fn(),
  deleteFromSpaces: jest.fn(),
  deleteSpacesObjectQuietly: jest.fn(),
  spacesKeyFor: jest.fn(),
  assertSpacesConfigured: jest.fn(),
  ALLOWED_IMAGE_TYPES: [],
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn(),
  scoutAssessCandidate: jest.fn(),
  scoutShortlistSummary: jest.fn(),
  assessTalentFit: jest.fn(),
}));

jest.mock("../src/utils/text.js", () => ({
  ...jest.requireActual("../src/utils/text.js"),
  extractText: jest.fn(),
}));

const spaces = jest.requireMock("../src/utils/integrations/spaces.js") as {
  uploadPrivateToSpaces: jest.Mock;
  getFromSpaces: jest.Mock;
  uploadToSpaces: jest.Mock;
  spacesKeyFor: jest.Mock;
};

const ai = jest.requireMock("../src/utils/integrations/openai.js") as {
  createEmbedding: jest.Mock;
  scoutAssessCandidate: jest.Mock;
  scoutShortlistSummary: jest.Mock;
  assessTalentFit: jest.Mock;
};

const textUtils = jest.requireMock("../src/utils/text.js") as { extractText: jest.Mock };

let app: ReturnType<typeof createApp>;

const scoutRepo = () => testDataSource.getRepository(Scout);
const runRepo = () => testDataSource.getRepository(ScoutRun);
const scoutsForRun = (runId: string) =>
  scoutRepo().find({ where: { scoutRunId: runId }, order: { position: "ASC" } });

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

beforeEach(() => {
  spaces.uploadPrivateToSpaces.mockResolvedValue(undefined);
  spaces.getFromSpaces.mockResolvedValue(Buffer.from("cv bytes"));
  spaces.uploadToSpaces.mockResolvedValue("https://cdn.example.com/x.pdf");
  spaces.spacesKeyFor.mockImplementation(
    (prefix: string, owner: string) =>
      `${prefix}/${owner}/${Math.random().toString(36).slice(2)}.pdf`
  );

  ai.createEmbedding.mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]);
  ai.scoutAssessCandidate.mockResolvedValue(assessmentResponse());
  ai.scoutShortlistSummary.mockResolvedValue({
    message: { content: JSON.stringify({ summary: "All three sell into banks." }) },
  });
  ai.assessTalentFit.mockResolvedValue({
    message: { content: JSON.stringify({ strengths: [], weaknesses: [] }) },
  });

  textUtils.extractText.mockResolvedValue("Ada Obi. Enterprise AE. Paystack.");
});

afterEach(async () => {
  await clearAllTables();
  jest.clearAllMocks();
});

/** A campaign owned by a recruiter with an active company, ready to run. */
const setupCampaign = async (shortlistSize = 2) => {
  const { user, token } = await createRecruiter();
  const org = await createOrganization(user);
  const job = await createScoutJob(user, undefined, {
    organizationId: org.id,
    shortlistSize,
    mustHaveSkills: ["negotiation"],
  });
  return { user, token, org, job };
};

const uploadRequest = (
  token: string,
  jobId: string,
  fileNames: string[],
  idempotencyKey: string
) => {
  const req = request(app)
    .post(`/v1/scout/jobs/${jobId}/runs`)
    .set("Authorization", `Bearer ${token}`)
    .field("idempotencyKey", idempotencyKey);
  for (const name of fileNames) {
    req.attach("cv", Buffer.from(`content of ${name}`), {
      filename: name,
      contentType: "application/pdf",
    });
  }
  return req;
};

/**
 * Uploads and then waits for the worker the request kicked off. Mocks must be set up
 * *before* calling this: by the time it returns, scoring has already happened.
 * Without the drain the fire-and-forget worker races every assertion below it.
 */
const upload = async (
  token: string,
  jobId: string,
  fileNames: string[],
  idempotencyKey = `key-${Math.random().toString(36).slice(2)}`
) => {
  const res = await uploadRequest(token, jobId, fileNames, idempotencyKey);
  await scoutRunService.drainInFlightScoutRuns();
  return res;
};

const runFrom = (res: request.Response): ScoutRun => apiData<{ run: ScoutRun }>(res).run;

/** Descending scores so a ranking is unambiguous. */
const descendingScores = (start = 90, step = 10) => {
  let score = start + step;
  ai.scoutAssessCandidate.mockImplementation(() =>
    Promise.resolve(assessmentResponse({ overallScore: (score -= step) }))
  );
};

/** Re-runs a campaign until every CV reaches a terminal state, ignoring backoff. */
const drainRetries = async (runId: string) => {
  for (let i = 0; i <= MAX_DURABLE_ATTEMPTS; i++) {
    await scoutRepo().update({ scoutRunId: runId }, { nextRetryAt: null, lockedAt: null });
    await scoutRunService.processScoutRun(runId).catch(() => undefined);
  }
};

describe("POST /v1/scout/jobs/:id/runs — happy path", () => {
  it("accepts the upload immediately, then scores and ranks every CV", async () => {
    const { token, job } = await setupCampaign(2);
    descendingScores();

    const res = await upload(token, job.id, ["a.pdf", "b.pdf", "c.pdf"]);
    expect(res.status).toBe(202);
    const run = runFrom(res);
    expect(run.totalCvs).toBe(3);
    expect(run.status).toBe(ScoutRunStatus.Processing);

    const rows = await scoutsForRun(run.id);
    expect(rows.every((row) => row.status === ScoutCvStatus.Scored)).toBe(true);

    const ranked = [...rows].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    expect(ranked.map((row) => row.rank)).toEqual([1, 2, 3]);
    expect(ranked.filter((row) => row.shortlisted)).toHaveLength(2);
    expect(ranked[0]!.shortlisted).toBe(true);
    expect(ranked[2]!.shortlisted).toBe(false);

    const finished = await runRepo().findOneByOrFail({ id: run.id });
    expect(finished.status).toBe(ScoutRunStatus.Completed);
    expect(finished.completedAt).not.toBeNull();
  });

  it("honours a shortlist size larger than the number of CVs uploaded", async () => {
    const { token, job } = await setupCampaign(10);
    const res = await upload(token, job.id, ["a.pdf", "b.pdf"]);

    const rows = await scoutsForRun(runFrom(res).id);
    expect(rows.every((row) => row.shortlisted)).toBe(true);
  });

  it("stores the plain-English reason and the extracted candidate record", async () => {
    const { token, job } = await setupCampaign();
    const res = await upload(token, job.id, ["a.pdf"]);

    const [row] = await scoutsForRun(runFrom(res).id);
    expect(row!.recommendation).toContain("six-figure deals");
    expect(row!.candidateName).toBe("Ada Obi");
    expect(row!.candidateEmail).toBe("ada@example.com");
    expect(row!.candidateAddress).toBe("Lagos, Lagos, Nigeria");
    expect(row!.insights).toContain("Strengths:");
    expect(row!.insights).toContain("Met must-haves:");
  });

  it("passes the campaign's targeting into the model's context", async () => {
    const { token, job } = await setupCampaign();
    await upload(token, job.id, ["a.pdf"]);

    const context = ai.scoutAssessCandidate.mock.calls[0]![0] as {
      mustHaveSkills: string[];
      jobBrief: string;
      recruiterGuide: string;
    };
    expect(context.mustHaveSkills).toEqual(["negotiation"]);
    expect(context.jobBrief).toBe(job.jobBrief);
    expect(context.recruiterGuide).toBe(job.recruiterGuide);
  });

  it("writes a comparative shortlist summary", async () => {
    const { token, job } = await setupCampaign();
    const res = await upload(token, job.id, ["a.pdf"]);
    await scoutRunService.drainInFlightScoutRuns();

    expect((await runRepo().findOneByOrFail({ id: runFrom(res).id })).shortlistSummary).toBe(
      "All three sell into banks."
    );
  });

  it("adds the candidate to the platform-wide pool", async () => {
    const { token, job } = await setupCampaign();
    const res = await upload(token, job.id, ["a.pdf"]);

    const candidates = await testDataSource.getRepository(ScoutCandidate).find();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.emailNormalized).toBe("ada@example.com");
    expect(candidates[0]!.skills).toEqual(["negotiation", "crm"]);

    const [row] = await scoutsForRun(runFrom(res).id);
    expect(row!.candidateId).toBe(candidates[0]!.id);
  });

  it("dedupes the same person across two runs into one pool row", async () => {
    const { token, job } = await setupCampaign();
    await upload(token, job.id, ["first.pdf"]);
    await upload(token, job.id, ["second.pdf"]);

    expect(await testDataSource.getRepository(ScoutCandidate).count()).toBe(1);
  });

  it("creates separate pool rows for candidates with no email to dedupe on", async () => {
    const { token, job } = await setupCampaign();
    ai.scoutAssessCandidate.mockResolvedValue(
      assessmentResponse({
        candidate: {
          fullName: "No Email",
          email: null,
          phone: null,
          city: null,
          state: null,
          country: null,
          headline: null,
          yearsExperience: null,
          skills: [],
        },
      })
    );

    await upload(token, job.id, ["a.pdf", "b.pdf"]);

    expect(await testDataSource.getRepository(ScoutCandidate).count()).toBe(2);
  });

  it("stores the CV file privately rather than public-read", async () => {
    const { token, job } = await setupCampaign();
    await upload(token, job.id, ["a.pdf"]);

    expect(spaces.uploadPrivateToSpaces).toHaveBeenCalledTimes(1);
    expect(spaces.uploadToSpaces).not.toHaveBeenCalled();
  });
});

describe("idempotency", () => {
  it("returns the same run for a repeated key and does not create a second set of rows", async () => {
    const { token, job } = await setupCampaign();
    const key = "repeated-key-123";

    const first = await upload(token, job.id, ["a.pdf"], key);
    expect(first.status).toBe(202);
    const second = await upload(token, job.id, ["a.pdf"], key);
    expect(second.status).toBe(200);

    expect(runFrom(second).id).toBe(runFrom(first).id);
    expect(await runRepo().count()).toBe(1);
    expect(await scoutRepo().count()).toBe(1);
  });

  it("creates separate runs for different keys", async () => {
    const { token, job } = await setupCampaign();
    const first = await upload(token, job.id, ["a.pdf"], "key-one-aaaa");
    const second = await upload(token, job.id, ["a.pdf"], "key-two-bbbb");

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await runRepo().count()).toBe(2);
  });

  it("does not re-upload to storage on a duplicate submit", async () => {
    const { token, job } = await setupCampaign();
    await upload(token, job.id, ["a.pdf"], "same");
    spaces.uploadPrivateToSpaces.mockClear();
    await upload(token, job.id, ["a.pdf"], "same");
    expect(spaces.uploadPrivateToSpaces).not.toHaveBeenCalled();
  });

  it("holds to one run when the same key is submitted concurrently", async () => {
    const { token, job } = await setupCampaign();
    const key = "concurrent-key";

    await Promise.all([
      uploadRequest(token, job.id, ["a.pdf"], key),
      uploadRequest(token, job.id, ["a.pdf"], key),
    ]);
    await scoutRunService.drainInFlightScoutRuns();

    expect(await runRepo().count()).toBe(1);
  });

  it("requires an idempotency key", async () => {
    const { token, job } = await setupCampaign();
    const res = await request(app)
      .post(`/v1/scout/jobs/${job.id}/runs`)
      .set("Authorization", `Bearer ${token}`)
      .attach("cv", Buffer.from("x"), { filename: "a.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(400);
  });
});

describe("ranking determinism", () => {
  it("breaks ties by upload order, not at random", async () => {
    const { token, job } = await setupCampaign(2);
    // Every CV scores identically, so only the tie-break can order them.
    ai.scoutAssessCandidate.mockResolvedValue(assessmentResponse({ overallScore: 70 }));

    const res = await upload(token, job.id, ["first.pdf", "second.pdf", "third.pdf"]);

    const rows = await scoutsForRun(runFrom(res).id);
    const byRank = [...rows].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    expect(byRank.map((row) => row.cvName)).toEqual(["first", "second", "third"]);
  });

  it("is unchanged by running finalizeRun repeatedly", async () => {
    const { token, job } = await setupCampaign(2);
    descendingScores();
    const res = await upload(token, job.id, ["a.pdf", "b.pdf", "c.pdf"]);
    const runId = runFrom(res).id;

    const snapshot = async () =>
      (await scoutsForRun(runId)).map((row) => `${row.id}:${row.rank}:${row.shortlisted}`);

    const before = await snapshot();
    for (let i = 0; i < 5; i++) await scoutRunService.finalizeRun(runId);
    expect(await snapshot()).toEqual(before);
  });

  it("assigns contiguous ranks over only the CVs that scored", async () => {
    const { token, job } = await setupCampaign(2);
    textUtils.extractText.mockImplementation(async (buffer: Buffer) => {
      if (buffer.toString("utf-8") === "cv bytes") return "Ada Obi. Enterprise AE.";
      return "Ada Obi. Enterprise AE.";
    });

    let call = 0;
    ai.scoutAssessCandidate.mockImplementation(() => {
      call++;
      if (call === 2) return Promise.reject(new Error("model exploded"));
      return Promise.resolve(assessmentResponse({ overallScore: 90 - call * 5 }));
    });

    const res = await upload(token, job.id, ["a.pdf", "b.pdf", "c.pdf"]);
    await drainRetries(runFrom(res).id);

    const rows = await scoutsForRun(runFrom(res).id);
    const scored = rows.filter((row) => row.status === ScoutCvStatus.Scored);
    const failedRows = rows.filter((row) => row.status === ScoutCvStatus.Failed);

    expect(scored.length).toBeGreaterThan(0);
    expect(scored.length + failedRows.length).toBe(3);
    expect(scored.map((row) => row.rank).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      Array.from({ length: scored.length }, (_, i) => i + 1)
    );
    // A CV that never scored has no defensible rank.
    expect(failedRows.every((row) => row.rank === null && row.shortlisted === false)).toBe(true);
  });
});

describe("concurrency and crash recovery", () => {
  it("scores a CV exactly once when workers race for it", async () => {
    const { token, job } = await setupCampaign();
    const res = await uploadRequest(token, job.id, ["a.pdf"], "race-key");
    await scoutRunService.drainInFlightScoutRuns();
    const [row] = await scoutsForRun(runFrom(res).id);

    // Reset to queued so the claim is genuinely contested by the three callers below.
    await scoutRepo().update(row!.id, {
      status: ScoutCvStatus.Queued,
      lockedAt: null,
      attempts: 0,
    });
    ai.scoutAssessCandidate.mockClear();

    await Promise.all([
      scoutRunService.processScoutCv(row!.id),
      scoutRunService.processScoutCv(row!.id),
      scoutRunService.processScoutCv(row!.id),
    ]);

    expect(ai.scoutAssessCandidate).toHaveBeenCalledTimes(1);
  });

  it("reclaims a CV whose lock has gone stale", async () => {
    const { token, job } = await setupCampaign();
    const res = await upload(token, job.id, ["a.pdf"]);
    const [row] = await scoutsForRun(runFrom(res).id);

    // Looks like a process that died mid-scoring, ten minutes ago.
    await scoutRepo().update(row!.id, {
      status: ScoutCvStatus.Processing,
      lockedAt: new Date(Date.now() - 10 * 60 * 1000),
      attempts: 0,
      nextRetryAt: null,
    });

    await scoutRunService.reconcileDueScoutCvs();

    expect((await scoutRepo().findOneByOrFail({ id: row!.id })).status).toBe(ScoutCvStatus.Scored);
  });

  it("leaves a CV alone while its lock is still fresh", async () => {
    const { token, job } = await setupCampaign();
    const res = await upload(token, job.id, ["a.pdf"]);
    const [row] = await scoutsForRun(runFrom(res).id);

    await scoutRepo().update(row!.id, {
      status: ScoutCvStatus.Processing,
      lockedAt: new Date(Date.now() - 60 * 1000),
      attempts: 0,
      nextRetryAt: null,
    });
    ai.scoutAssessCandidate.mockClear();

    await scoutRunService.reconcileDueScoutCvs();

    expect((await scoutRepo().findOneByOrFail({ id: row!.id })).status).toBe(
      ScoutCvStatus.Processing
    );
    expect(ai.scoutAssessCandidate).not.toHaveBeenCalled();
  });

  it("closes out a run left on processing after every CV settled", async () => {
    const { token, job } = await setupCampaign();
    const res = await upload(token, job.id, ["a.pdf"]);
    const runId = runFrom(res).id;

    // As if the process died between the last CV finishing and finalizeRun.
    await runRepo().update(runId, { status: ScoutRunStatus.Processing, completedAt: null });

    await scoutRunService.reconcileDueScoutCvs();

    expect((await runRepo().findOneByOrFail({ id: runId })).status).toBe(ScoutRunStatus.Completed);
  });

  it("does not finalize a run while a CV could still succeed", async () => {
    const { token, job } = await setupCampaign();
    const res = await uploadRequest(token, job.id, ["a.pdf", "b.pdf"], "pending-key");
    const runId = runFrom(res).id;
    await scoutRunService.drainInFlightScoutRuns();

    const rows = await scoutsForRun(runId);
    await scoutRepo().update(rows[0]!.id, { status: ScoutCvStatus.Queued, attempts: 0 });
    await runRepo().update(runId, { status: ScoutRunStatus.Processing, completedAt: null });

    await scoutRunService.finalizeRun(runId);

    expect((await runRepo().findOneByOrFail({ id: runId })).status).toBe(ScoutRunStatus.Processing);
  });
});

describe("failure handling", () => {
  it("finishes with errors when some CVs fail and keeps the rest", async () => {
    const { token, job } = await setupCampaign(2);
    let call = 0;
    // Two of the five CVs are unreadable, which is permanent and not retried.
    textUtils.extractText.mockImplementation(async () => {
      call++;
      if (call === 2 || call === 4) return "";
      return "Ada Obi. Enterprise AE.";
    });

    const res = await upload(token, job.id, ["a.pdf", "b.pdf", "c.pdf", "d.pdf", "e.pdf"]);

    const rows = await scoutsForRun(runFrom(res).id);
    expect(rows.filter((row) => row.status === ScoutCvStatus.Scored)).toHaveLength(3);
    expect(rows.filter((row) => row.status === ScoutCvStatus.Failed)).toHaveLength(2);
    expect((await runRepo().findOneByOrFail({ id: runFrom(res).id })).status).toBe(
      ScoutRunStatus.CompletedWithErrors
    );
  });

  it("marks the run failed when nothing could be scored", async () => {
    const { token, job } = await setupCampaign();
    textUtils.extractText.mockResolvedValue("");

    const res = await upload(token, job.id, ["a.pdf"]);

    expect((await runRepo().findOneByOrFail({ id: runFrom(res).id })).status).toBe(
      ScoutRunStatus.Failed
    );
  });

  it("never retries an unreadable file, and never calls the model for it", async () => {
    const { token, job } = await setupCampaign();
    textUtils.extractText.mockResolvedValue("   ");

    const res = await upload(token, job.id, ["scan.pdf"]);

    const [row] = await scoutsForRun(runFrom(res).id);
    expect(row!.status).toBe(ScoutCvStatus.Failed);
    expect(row!.attempts).toBe(MAX_DURABLE_ATTEMPTS);
    expect(row!.nextRetryAt).toBeNull();
    expect(row!.lastError).toContain("scanned image");
    expect(ai.scoutAssessCandidate).not.toHaveBeenCalled();

    // And the sweep must not pick it up again.
    await scoutRunService.reconcileDueScoutCvs();
    expect(ai.scoutAssessCandidate).not.toHaveBeenCalled();
  });

  it("gives a corrupt file a human-readable reason", async () => {
    const { token, job } = await setupCampaign();
    textUtils.extractText.mockRejectedValue(new Error("bad xref table"));

    const res = await upload(token, job.id, ["broken.pdf"]);

    const [row] = await scoutsForRun(runFrom(res).id);
    expect(row!.lastError).toContain("corrupted or password protected");
    expect(row!.attempts).toBe(MAX_DURABLE_ATTEMPTS);
  });

  it("retries a transient model failure, then gives up after the attempt budget", async () => {
    const { token, job } = await setupCampaign();
    ai.scoutAssessCandidate.mockRejectedValue(new Error("503 upstream"));

    const res = await upload(token, job.id, ["a.pdf"]);
    const runId = runFrom(res).id;

    // One attempt is spent by the upload's own worker; drain the remainder.
    await drainRetries(runId);

    const [row] = await scoutsForRun(runId);
    expect(row!.status).toBe(ScoutCvStatus.Failed);
    expect(row!.attempts).toBe(MAX_DURABLE_ATTEMPTS);
    expect(row!.nextRetryAt).toBeNull();
    expect(row!.lastError).toContain("503 upstream");
  });

  it("backs off rather than hammering the model on the first failure", async () => {
    const { token, job } = await setupCampaign();
    ai.scoutAssessCandidate.mockRejectedValue(new Error("503 upstream"));

    const res = await upload(token, job.id, ["a.pdf"]);

    const [row] = await scoutsForRun(runFrom(res).id);
    expect(row!.attempts).toBe(1);
    expect(row!.nextRetryAt).not.toBeNull();
    expect(row!.status).toBe(ScoutCvStatus.Queued);
  });

  it("writes no run and no rows when storage fails", async () => {
    const { token, job } = await setupCampaign();
    spaces.uploadPrivateToSpaces.mockRejectedValueOnce(new Error("Spaces is down"));

    const res = await upload(token, job.id, ["a.pdf"]);

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await runRepo().count()).toBe(0);
    expect(await scoutRepo().count()).toBe(0);
  });

  it("survives the campaign being deleted mid-run", async () => {
    const { token, job } = await setupCampaign();
    const res = await uploadRequest(token, job.id, ["a.pdf"], "deleted-key");
    const runId = runFrom(res).id;
    await scoutRunService.drainInFlightScoutRuns();

    await request(app).delete(`/v1/scout/jobs/${job.id}`).set("Authorization", `Bearer ${token}`);

    await expect(scoutRunService.processScoutRun(runId)).resolves.toBeUndefined();
  });
});

describe("malformed AI responses", () => {
  const badCases: Array<{ label: string; content: string }> = [
    { label: "missing overallScore", content: assessmentPayload({ overallScore: undefined }) },
    { label: "overallScore as a string", content: assessmentPayload({ overallScore: "80" }) },
    { label: "overallScore above 100", content: assessmentPayload({ overallScore: 150 }) },
    { label: "a negative overallScore", content: assessmentPayload({ overallScore: -1 }) },
    { label: "overallScore not finite", content: assessmentPayload({ overallScore: null }) },
    { label: "an empty recommendation", content: assessmentPayload({ recommendation: "" }) },
    { label: "a one-word recommendation", content: assessmentPayload({ recommendation: "Good" }) },
    { label: "missing candidate details", content: assessmentPayload({ candidate: undefined }) },
    { label: "invalid JSON", content: "{not json" },
    { label: "a JSON array", content: "[]" },
    { label: "an empty body", content: "" },
  ];

  for (const { label, content } of badCases) {
    it(`rejects ${label}`, async () => {
      const { token, job } = await setupCampaign();
      ai.scoutAssessCandidate.mockResolvedValue({ message: { content } });

      const res = await upload(token, job.id, ["a.pdf"]);

      const [row] = await scoutsForRun(runFrom(res).id);
      expect(row!.status).not.toBe(ScoutCvStatus.Scored);
      expect(row!.attempts).toBeGreaterThan(0);
    });
  }

  it("accepts a score of zero — it is a real verdict, not a malformed response", async () => {
    const { token, job } = await setupCampaign();
    ai.scoutAssessCandidate.mockResolvedValue(assessmentResponse({ overallScore: 0 }));

    const res = await upload(token, job.id, ["a.pdf"]);

    const [row] = await scoutsForRun(runFrom(res).id);
    expect(row!.status).toBe(ScoutCvStatus.Scored);
    expect(row!.evaluationScore).toBe(0);
    expect(row!.attempts).toBe(0);
  });

  it("tolerates missing optional arrays", async () => {
    const { token, job } = await setupCampaign();
    ai.scoutAssessCandidate.mockResolvedValue(
      assessmentResponse({
        strengths: undefined,
        concerns: undefined,
        mustHaveSkillsMet: undefined,
      })
    );

    const res = await upload(token, job.id, ["a.pdf"]);

    expect((await scoutsForRun(runFrom(res).id))[0]!.status).toBe(ScoutCvStatus.Scored);
  });
});

describe("input limits", () => {
  it("truncates a very long CV before sending it to the model", async () => {
    const { token, job } = await setupCampaign();
    textUtils.extractText.mockResolvedValue("x".repeat(MAX_CV_CHARS * 5));

    await upload(token, job.id, ["long.pdf"]);

    const context = ai.scoutAssessCandidate.mock.calls[0]![0] as { cv: string };
    expect(context.cv.length).toBeLessThanOrEqual(MAX_CV_CHARS);
  });

  it(`accepts exactly ${MAX_BATCH_SIZE} CVs`, async () => {
    const { token, job } = await setupCampaign();
    const names = Array.from({ length: MAX_BATCH_SIZE }, (_, i) => `cv-${i}.pdf`);
    const res = await upload(token, job.id, names);
    expect(res.status).toBe(202);
    expect(runFrom(res).totalCvs).toBe(MAX_BATCH_SIZE);
  });

  it(`rejects ${MAX_BATCH_SIZE + 1} CVs`, async () => {
    const { token, job } = await setupCampaign();
    const names = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => `cv-${i}.pdf`);
    const res = await upload(token, job.id, names);
    expect(res.status).toBe(400);
    expect(await runRepo().count()).toBe(0);
  });

  it("rejects an upload with no files", async () => {
    const { token, job } = await setupCampaign();
    const res = await request(app)
      .post(`/v1/scout/jobs/${job.id}/runs`)
      .set("Authorization", `Bearer ${token}`)
      .field("idempotencyKey", "no-files-key");
    expect(res.status).toBe(400);
  });

  it("rejects a file that is not a PDF or Word document", async () => {
    const { token, job } = await setupCampaign();
    const res = await request(app)
      .post(`/v1/scout/jobs/${job.id}/runs`)
      .set("Authorization", `Bearer ${token}`)
      .field("idempotencyKey", "wrong-mime")
      .attach("cv", Buffer.from("image bytes"), {
        filename: "photo.png",
        contentType: "image/png",
      });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("PDF");
  });

  it("accepts a Word document", async () => {
    const { token, job } = await setupCampaign();
    const res = await request(app)
      .post(`/v1/scout/jobs/${job.id}/runs`)
      .set("Authorization", `Bearer ${token}`)
      .field("idempotencyKey", "docx-key")
      .attach("cv", Buffer.from("docx bytes"), {
        filename: "cv.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
    await scoutRunService.drainInFlightScoutRuns();
    expect(res.status).toBe(202);
  });
});

describe("access control", () => {
  it("401s without a token", async () => {
    const { job } = await setupCampaign();
    const res = await request(app)
      .post(`/v1/scout/jobs/${job.id}/runs`)
      .field("idempotencyKey", "anon");
    expect(res.status).toBe(401);
  });

  it("403s a recruiter from another company", async () => {
    const { job } = await setupCampaign();
    const { user: other, token: otherToken } = await createRecruiter();
    await createOrganization(other);

    const res = await upload(otherToken, job.id, ["a.pdf"]);
    expect(res.status).toBe(403);
    expect(await runRepo().count()).toBe(0);
  });

  it("403s a talent", async () => {
    const { job } = await setupCampaign();
    const talent = await createTalent();

    const res = await upload(talent.token, job.id, ["a.pdf"]);
    expect(res.status).toBe(403);
  });

  it("404s an unknown campaign", async () => {
    const { token } = await setupCampaign();
    const res = await upload(token, "11111111-1111-4111-8111-111111111111", ["a.pdf"]);
    expect(res.status).toBe(404);
  });
});

describe("plan limits", () => {
  const useUsage = async (organizationId: string, used: number) => {
    await testDataSource
      .getRepository(Organization)
      .update(organizationId, { billingPlan: "sme_basic" });
    await testDataSource.query(
      `INSERT INTO "feature_usage_counters"
         ("organization_id", "feature_key", "period_start", "count", "createdAt", "updatedAt")
       VALUES ($1, 'scout_cv_scans', date_trunc('month', now())::date, $2, now(), now())`,
      [organizationId, used]
    );
  };

  it("402s when the batch will not fit in the remaining monthly allowance", async () => {
    const { token, job, org } = await setupCampaign();
    // sme_basic allows 50/month; 48 used leaves room for 2, not 5.
    await useUsage(org.id, 48);

    const res = await upload(token, job.id, ["a.pdf", "b.pdf", "c.pdf", "d.pdf", "e.pdf"]);

    expect(res.status).toBe(402);
    expect(res.body.error.featureKey).toBe("scout_cv_scans");
    expect(await runRepo().count()).toBe(0);
  });

  it("allows a batch that exactly fills the remaining allowance", async () => {
    const { token, job, org } = await setupCampaign();
    await useUsage(org.id, 48);

    const res = await upload(token, job.id, ["a.pdf", "b.pdf"]);
    expect(res.status).toBe(202);
  });

  it("charges for every CV in the batch, once", async () => {
    const { token, job, org } = await setupCampaign();
    await testDataSource.getRepository(Organization).update(org.id, { billingPlan: "sme_basic" });

    await upload(token, job.id, ["a.pdf", "b.pdf"], "usage-key");
    await upload(token, job.id, ["a.pdf", "b.pdf"], "usage-key");

    const rows: Array<{ count: number }> = await testDataSource.query(
      `SELECT "count" FROM "feature_usage_counters"
        WHERE "organization_id" = $1 AND "feature_key" = 'scout_cv_scans'`,
      [org.id]
    );
    expect(rows[0]!.count).toBe(2);
  });
});

describe("GET /v1/scout/runs/:runId — polling", () => {
  it("reports per-status progress while a run is in flight", async () => {
    const { token, job } = await setupCampaign();
    const res = await uploadRequest(token, job.id, ["a.pdf", "b.pdf"], "poll-key");
    const runId = runFrom(res).id;

    const poll = await request(app)
      .get(`/v1/scout/runs/${runId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(poll.status).toBe(200);
    const body = apiData<{
      progress: { queued: number; processing: number; scored: number; failed: number };
      cvs: Scout[];
    }>(poll);
    expect(body.cvs).toHaveLength(2);
    expect(body.progress.queued + body.progress.processing + body.progress.scored).toBe(2);

    await scoutRunService.drainInFlightScoutRuns();
  });

  it("reports a terminal status and full counts once scoring finishes", async () => {
    const { token, job } = await setupCampaign();
    const res = await upload(token, job.id, ["a.pdf"]);

    const poll = await request(app)
      .get(`/v1/scout/runs/${runFrom(res).id}`)
      .set("Authorization", `Bearer ${token}`);

    const body = apiData<{ run: ScoutRun; progress: { scored: number; queued: number } }>(poll);
    expect(body.run.status).toBe(ScoutRunStatus.Completed);
    expect(body.progress.scored).toBe(1);
    expect(body.progress.queued).toBe(0);
  });

  it("403s another company's run", async () => {
    const { token, job } = await setupCampaign();
    const res = await upload(token, job.id, ["a.pdf"]);

    const { user: other, token: otherToken } = await createRecruiter();
    await createOrganization(other);

    const poll = await request(app)
      .get(`/v1/scout/runs/${runFrom(res).id}`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(poll.status).toBe(403);
  });

  it("404s an unknown run", async () => {
    const { token } = await setupCampaign();
    const res = await request(app)
      .get("/v1/scout/runs/11111111-1111-4111-8111-111111111111")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("400s a run id that is not a UUID", async () => {
    const { token } = await setupCampaign();
    const res = await request(app)
      .get("/v1/scout/runs/not-a-uuid")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/scout/runs/:runId/shortlist", () => {
  it("returns exactly the shortlisted CVs in rank order", async () => {
    const { token, job } = await setupCampaign(2);
    descendingScores();
    const res = await upload(token, job.id, ["a.pdf", "b.pdf", "c.pdf"]);

    const list = await request(app)
      .get(`/v1/scout/runs/${runFrom(res).id}/shortlist`)
      .set("Authorization", `Bearer ${token}`);

    const body = apiData<{ shortlist: Scout[] }>(list);
    expect(body.shortlist).toHaveLength(2);
    expect(body.shortlist.map((row) => row.rank)).toEqual([1, 2]);
    expect(body.shortlist[0]!.recommendation).toBeTruthy();
  });

  it("returns an empty shortlist for a run where nothing scored", async () => {
    const { token, job } = await setupCampaign();
    textUtils.extractText.mockResolvedValue("");
    const res = await upload(token, job.id, ["a.pdf"]);

    const list = await request(app)
      .get(`/v1/scout/runs/${runFrom(res).id}/shortlist`)
      .set("Authorization", `Bearer ${token}`);

    expect(apiData<{ shortlist: Scout[] }>(list).shortlist).toEqual([]);
  });
});

describe("POST /v1/scout/cvs/:scoutId/retry", () => {
  it("re-queues an exhausted CV and scores it on the next pass", async () => {
    const { token, job } = await setupCampaign();
    textUtils.extractText.mockResolvedValue("");
    const res = await upload(token, job.id, ["a.pdf"]);
    const runId = runFrom(res).id;

    const [failedRow] = await scoutsForRun(runId);
    expect(failedRow!.status).toBe(ScoutCvStatus.Failed);

    textUtils.extractText.mockResolvedValue("Ada Obi. Enterprise AE.");
    const retry = await request(app)
      .post(`/v1/scout/cvs/${failedRow!.id}/retry`)
      .set("Authorization", `Bearer ${token}`);
    expect(retry.status).toBe(200);
    await scoutRunService.drainInFlightScoutRuns();

    const rescored = await scoutRepo().findOneByOrFail({ id: failedRow!.id });
    expect(rescored.status).toBe(ScoutCvStatus.Scored);
    expect(rescored.lastError).toBeNull();
    expect((await runRepo().findOneByOrFail({ id: runId })).status).toBe(ScoutRunStatus.Completed);
  });

  it("refuses to retry a CV that already scored", async () => {
    const { token, job } = await setupCampaign();
    const res = await upload(token, job.id, ["a.pdf"]);
    const [row] = await scoutsForRun(runFrom(res).id);

    const retry = await request(app)
      .post(`/v1/scout/cvs/${row!.id}/retry`)
      .set("Authorization", `Bearer ${token}`);
    expect(retry.status).toBe(400);
  });

  it("403s a retry from another company", async () => {
    const { token, job } = await setupCampaign();
    const res = await upload(token, job.id, ["a.pdf"]);
    const [row] = await scoutsForRun(runFrom(res).id);

    const { user: other, token: otherToken } = await createRecruiter();
    await createOrganization(other);

    const retry = await request(app)
      .post(`/v1/scout/cvs/${row!.id}/retry`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(retry.status).toBe(403);
  });

  it("404s an unknown CV", async () => {
    const { token } = await setupCampaign();
    const retry = await request(app)
      .post("/v1/scout/cvs/11111111-1111-4111-8111-111111111111/retry")
      .set("Authorization", `Bearer ${token}`);
    expect(retry.status).toBe(404);
  });
});

describe("GET /v1/scout/jobs/:id/runs — history", () => {
  it("lists runs newest first with a total", async () => {
    const { token, job } = await setupCampaign();
    const first = await upload(token, job.id, ["a.pdf"], "run-one-key");
    const second = await upload(token, job.id, ["b.pdf"], "run-two-key");
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    const res = await request(app)
      .get(`/v1/scout/jobs/${job.id}/runs`)
      .set("Authorization", `Bearer ${token}`);

    const body = apiData<{ runs: ScoutRun[]; total: number }>(res);
    expect(body.total).toBe(2);
    expect(body.runs).toHaveLength(2);
    expect(new Date(body.runs[0]!.createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(body.runs[1]!.createdAt).getTime()
    );
  });

  it("403s another company's campaign history", async () => {
    const { job } = await setupCampaign();
    const { user: other, token: otherToken } = await createRecruiter();
    await createOrganization(other);

    const res = await request(app)
      .get(`/v1/scout/jobs/${job.id}/runs`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(403);
  });
});
