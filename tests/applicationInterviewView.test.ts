import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import {
  createAIConfig,
  createApplication,
  createJob,
  createOrganization,
  createRecruiter,
  createRole,
  createTalent,
} from "./helpers/fixtures.js";
import { AiInterview } from "../src/entities/AiInterview.js";
import { AiInterviewQuestion } from "../src/entities/AiInterviewQuestion.js";

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

const get = (path: string, token: string) =>
  request(app).get(path).set("Authorization", `Bearer ${token}`);

const setup = async (aiInterview: boolean) => {
  const { user: recruiter, token } = await createRecruiter();
  const org = await createOrganization(recruiter);
  const config = await createAIConfig(recruiter, {
    aiInterview,
    aiInterviewMode: aiInterview ? "audio_video" : null,
  });
  const job = await createJob(recruiter, await createRole("Growth Marketing Manager"), {
    organizationId: org.id,
    aiConfigId: config.id,
  });
  const { user: talent, token: talentToken } = await createTalent();
  const application = await createApplication(talent, job);
  return { token, talentToken, application };
};

describe("GET /v1/applications/:id interview for the company", () => {
  it("returns the interview with each answer's length and the flags' questions", async () => {
    const { token, talentToken, application } = await setup(true);
    const interview = await testDataSource.getRepository(AiInterview).save({
      applicationId: application.id,
      jobId: application.jobId,
      talentId: application.talentId,
      mode: "audio_video",
      status: "invited",
      invitedAt: new Date(),
      scoringStatus: "completed",
      summary: "Clear answers.",
      flags: ["Old plain flag", { text: "Numbers look high", question: 2 }],
    });
    const recordedAt = new Date("2026-11-12T11:41:00Z");
    await testDataSource.getRepository(AiInterviewQuestion).save([
      {
        interviewId: interview.id,
        position: 1,
        question: "Walk us through a campaign.",
        recordedAt,
        recordingDurationSeconds: 112,
        transcriptStatus: "completed",
        transcript: "We ran a campaign.",
      },
      {
        interviewId: interview.id,
        position: 1,
        isFollowUp: true,
        question: "What did you learn?",
        recordedAt: new Date(recordedAt.getTime() + 200_000),
        recordingDurationSeconds: 72,
      },
    ]);

    const res = await get(`/v1/applications/${application.id}`, token);

    expect(res.status).toBe(200);
    const view = res.body.data.application.interview;
    expect(view).toMatchObject({
      id: interview.id,
      mode: "audio_video",
      status: "ready",
      startedAt: recordedAt.toISOString(),
      summary: "Clear answers.",
      flags: [
        { text: "Old plain flag", question: null },
        { text: "Numbers look high", question: 2 },
      ],
    });
    expect(
      view.questions.map((q: { isFollowUp: boolean; durationSeconds: number }) => [
        q.isFollowUp,
        q.durationSeconds,
      ])
    ).toEqual([
      [false, 112],
      [true, 72],
    ]);
    expect(res.body.data.application.nextStep).toBe("shortlisted");

    const own = await get(`/v1/applications/${application.id}`, talentToken);
    expect(own.body.data.application.interview).toBeUndefined();
  });

  it("names the recorded interview as the next step while the candidate has none", async () => {
    const withInterview = await setup(true);
    const res = await get(`/v1/applications/${withInterview.application.id}`, withInterview.token);
    expect(res.body.data.application.interview).toBeNull();
    expect(res.body.data.application.nextStep).toBe("ai_interview");

    await clearAllTables();
    const without = await setup(false);
    const plain = await get(`/v1/applications/${without.application.id}`, without.token);
    expect(plain.body.data.application.nextStep).toBe("shortlisted");
  });
});
