/**
 * Applicant messaging tests — POST /v1/jobs/:jobId/applicants/messages/draft,
 * the AI mass-messaging flow: one personalized draft per selected candidate,
 * grounded in their own match evidence.
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
  createOrganization,
  createAdmin,
  createAiRecommendation,
  buildMatchAnalysis,
} from "./helpers/fixtures.js";
import { MatchVerdict } from "../src/types/enums.js";
import { draftApplicantMessage } from "../src/utils/integrations/openai.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  __esModule: true,
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
  draftApplicantMessage: jest.fn(),
}));

const mockDraft = draftApplicantMessage as jest.Mock;

const aiReply = (content: unknown) => ({
  message: { content: typeof content === "string" ? content : JSON.stringify(content) },
});

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
  mockDraft
    .mockReset()
    .mockResolvedValue(
      aiReply({ subject: "You're shortlisted!", body: "Hi there,\n\nGreat news." })
    );
});

const draftPath = (jobId: string) => `/v1/jobs/${jobId}/applicants/messages/draft`;
const draftAs = (token: string, jobId: string, body: Record<string, unknown>) =>
  request(app).post(draftPath(jobId)).set("Authorization", `Bearer ${token}`).send(body);

describe("POST /v1/jobs/:jobId/applicants/messages/draft — happy paths", () => {
  it("drafts one message per selected candidate", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talentA } = await createTalent({ firstName: "Ada" });
    const { user: talentB } = await createTalent({ firstName: "Bola" });
    const appA = await createApplication(talentA, job);
    const appB = await createApplication(talentB, job);

    mockDraft
      .mockResolvedValueOnce(aiReply({ subject: "For Ada", body: "Hi Ada, congrats!" }))
      .mockResolvedValueOnce(aiReply({ subject: "For Bola", body: "Hi Bola, congrats!" }));

    const res = await draftAs(token, job.id, { applicationIds: [appA.id, appB.id] });

    expect(res.status).toBe(200);
    expect(mockDraft).toHaveBeenCalledTimes(2);
    const drafts = res.body.data.drafts;
    expect(drafts).toHaveLength(2);
    const byApp = Object.fromEntries(
      drafts.map((d: { applicationId: string; subject: string; body: string }) => [
        d.applicationId,
        d,
      ])
    );
    expect(byApp[appA.id]).toEqual(
      expect.objectContaining({
        talentId: talentA.id,
        talentName: "Ada User",
        subject: "For Ada",
        body: "Hi Ada, congrats!",
      })
    );
    expect(byApp[appB.id]).toEqual(
      expect.objectContaining({
        talentId: talentB.id,
        talentName: "Bola User",
        subject: "For Bola",
        body: "Hi Bola, congrats!",
      })
    );
  });

  it("grounds each draft in that candidate's own match evidence, not a shared prompt", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole("Backend Engineer");
    const org = await createOrganization(recruiter, { name: "Acme Corp" });
    const job = await createJob(recruiter, role, { organizationId: org.id });
    const { user: talent, token: _t } = await createTalent({ firstName: "Ada" });
    expect(_t).toBeDefined();
    const application = await createApplication(talent, job, {
      matchVerdict: MatchVerdict.High,
      overallFitScore: 91,
    });
    await createAiRecommendation(application, {
      analysis: buildMatchAnalysis({
        overallFitScore: 91,
        whyHire: "Shipped three production Kubernetes migrations solo.",
        strongestQualifications: ["Kubernetes migrations", "On-call leadership"],
        keyEvidence: ["CV: led K8s migration at Acme, 2022"],
      }),
    });

    await draftAs(token, job.id, {
      applicationIds: [application.id],
      intent: "Invite to interview",
    });

    expect(mockDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        talentFirstName: "Ada",
        jobTitle: "Backend Engineer",
        companyName: "Acme Corp",
        recruiterFirstName: recruiter.firstName,
        intent: "Invite to interview",
        verdict: "high",
        whyHire: "Shipped three production Kubernetes migrations solo.",
        strongestQualifications: ["Kubernetes migrations", "On-call leadership"],
        keyEvidence: ["CV: led K8s migration at Acme, 2022"],
      })
    );
  });

  it("still drafts a message for a candidate with no AI verdict yet, with empty evidence rather than erroring", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const application = await createApplication(talent, job); // no verdict, no AiRecommendation row

    const res = await draftAs(token, job.id, { applicationIds: [application.id] });

    expect(res.status).toBe(200);
    expect(res.body.data.drafts).toHaveLength(1);
    expect(res.body.data.drafts[0]).toEqual(
      expect.objectContaining({ subject: "You're shortlisted!", body: "Hi there,\n\nGreat news." })
    );
    expect(mockDraft).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: null, whyHire: undefined })
    );
    expect(mockDraft.mock.calls[0]![0]).not.toHaveProperty("overallFitScore");
  });

  it("uses matchStrengths as a fallback for strongestQualifications when there's no structured analysis", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    // Denormalized columns set directly (legacy path), no AiRecommendation row.
    const application = await createApplication(talent, job, {
      matchVerdict: MatchVerdict.Medium,
      matchStrengths: ["Five years of Python experience"],
    });

    await draftAs(token, job.id, { applicationIds: [application.id] });

    expect(mockDraft).toHaveBeenCalledWith(
      expect.objectContaining({ strongestQualifications: ["Five years of Python experience"] })
    );
  });

  it("omits intent from the AI context when the recruiter doesn't supply one", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const application = await createApplication(talent, job);

    await draftAs(token, job.id, { applicationIds: [application.id] });

    expect(mockDraft).toHaveBeenCalledWith(expect.objectContaining({ intent: undefined }));
  });

  it("lets an Admin draft messages for any recruiter's job", async () => {
    const { user: recruiter } = await createRecruiter();
    const { token: adminToken } = await createAdmin();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const application = await createApplication(talent, job);

    const res = await draftAs(adminToken, job.id, { applicationIds: [application.id] });

    expect(res.status).toBe(200);
  });
});

describe("POST /v1/jobs/:jobId/applicants/messages/draft — partial failures don't fail the whole batch", () => {
  it("returns a per-candidate error when the AI call rejects for just one candidate", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talentA } = await createTalent();
    const { user: talentB } = await createTalent();
    const appA = await createApplication(talentA, job);
    const appB = await createApplication(talentB, job);

    mockDraft
      .mockRejectedValueOnce(new Error("OpenAI timeout"))
      .mockResolvedValueOnce(aiReply({ subject: "For B", body: "Hi B" }));

    const res = await draftAs(token, job.id, { applicationIds: [appA.id, appB.id] });

    expect(res.status).toBe(200);
    const drafts = res.body.data.drafts;
    const byApp = Object.fromEntries(
      drafts.map((d: { applicationId: string }) => [d.applicationId, d])
    );
    expect(byApp[appA.id].error).toMatch(/couldn't draft a message/i);
    expect(byApp[appA.id].subject).toBeUndefined();
    expect(byApp[appB.id]).toEqual(expect.objectContaining({ subject: "For B", body: "Hi B" }));
  });

  it("returns a per-candidate error when the AI returns unparsable JSON for one candidate", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const application = await createApplication(talent, job);

    mockDraft.mockResolvedValueOnce(aiReply("Dear candidate, ..."));

    const res = await draftAs(token, job.id, { applicationIds: [application.id] });

    expect(res.status).toBe(200);
    expect(res.body.data.drafts[0].error).toMatch(/couldn't draft a message/i);
  });

  it("returns a per-candidate error when the AI returns an empty response", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const application = await createApplication(talent, job);

    mockDraft.mockResolvedValueOnce({ message: { content: null } });

    const res = await draftAs(token, job.id, { applicationIds: [application.id] });

    expect(res.status).toBe(200);
    expect(res.body.data.drafts[0].error).toMatch(/couldn't draft a message/i);
  });
});

describe("POST /v1/jobs/:jobId/applicants/messages/draft — validation and access", () => {
  it.each([
    ["missing applicationIds", {}],
    ["an empty applicationIds array", { applicationIds: [] }],
    ["a non-UUID applicationId", { applicationIds: ["not-a-uuid"] }],
    ["an intent longer than 500 characters", { applicationIds: [], intent: "x".repeat(501) }],
  ])("400s for %s", async (_label, body) => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    expect(recruiter).toBeDefined();

    const res = await draftAs(token, job.id, body);

    expect(res.status).toBe(400);
    expect(mockDraft).not.toHaveBeenCalled();
  });

  it("404s for a job that doesn't exist", async () => {
    const { token } = await createRecruiter();
    const res = await draftAs(token, "00000000-0000-4000-8000-000000000000", {
      applicationIds: ["00000000-0000-4000-8000-000000000001"],
    });
    expect(res.status).toBe(404);
  });

  it("400s when none of the given applicationIds belong to the job", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const otherJob = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const foreignApplication = await createApplication(talent, otherJob);

    const res = await draftAs(token, job.id, { applicationIds: [foreignApplication.id] });

    expect(res.status).toBe(400);
    expect(mockDraft).not.toHaveBeenCalled();
  });

  it("silently excludes an applicationId from a different job when at least one valid id is present", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const otherJob = await createJob(recruiter, role);
    const { user: talentOnJob } = await createTalent();
    const { user: talentOnOtherJob } = await createTalent();
    const validApp = await createApplication(talentOnJob, job);
    const foreignApp = await createApplication(talentOnOtherJob, otherJob);

    const res = await draftAs(token, job.id, {
      applicationIds: [validApp.id, foreignApp.id],
    });

    expect(res.status).toBe(200);
    expect(res.body.data.drafts).toHaveLength(1);
    expect(res.body.data.drafts[0].applicationId).toBe(validApp.id);
  });

  it("requires auth and ownership", async () => {
    const { user: recruiter } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const application = await createApplication(talent, job);
    const { token: talentToken } = await createTalent();
    const { token: otherRecruiterToken } = await createRecruiter();

    expect(
      (
        await request(app)
          .post(draftPath(job.id))
          .send({ applicationIds: [application.id] })
      ).status
    ).toBe(401);
    expect((await draftAs(talentToken, job.id, { applicationIds: [application.id] })).status).toBe(
      403
    );
    expect(
      (await draftAs(otherRecruiterToken, job.id, { applicationIds: [application.id] })).status
    ).toBe(403);
    expect(mockDraft).not.toHaveBeenCalled();
  });
});

describe("POST /v1/jobs/:jobId/applicants/messages/draft — caps batch size", () => {
  it("400s for more than 50 applicationIds without touching the AI or the database", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const tooMany = Array.from({ length: 51 }, (_, i) => {
      const hex = i.toString(16).padStart(12, "0");
      return `00000000-0000-4000-8000-${hex}`;
    });

    const res = await draftAs(token, job.id, { applicationIds: tooMany });

    expect(res.status).toBe(400);
    expect(mockDraft).not.toHaveBeenCalled();
  });
});
