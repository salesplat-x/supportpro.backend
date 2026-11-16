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
import { Application } from "../src/entities/Application.js";
import { Message } from "../src/entities/Message.js";
import { ApplicationStatus } from "../src/types/enums.js";
import * as AI from "../src/utils/integrations/openai.js";
import EmailService from "../src/utils/integrations/email/emailService.js";

const mockSendInvite = jest.fn();
const mockSendApplicantMessage = jest.fn();

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
  generateAiInterviewQuestions: jest.fn(),
}));

const mockQuestions = AI.generateAiInterviewQuestions as jest.Mock;

const FIVE = ["One?", "Two?", "Three?", "Four?", "Five?"];

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

beforeEach(() => {
  (EmailService as unknown as jest.Mock).mockImplementation(() => ({
    sendAiInterviewInvite: mockSendInvite,
    sendApplicantMessage: mockSendApplicantMessage,
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  }));
  mockSendInvite.mockResolvedValue(undefined);
  mockSendApplicantMessage.mockResolvedValue(undefined);
  mockQuestions.mockResolvedValue({ message: { content: JSON.stringify({ questions: FIVE }) } });
});

afterEach(async () => {
  await clearAllTables();
  jest.clearAllMocks();
});

const setup = async (aiInterview = true) => {
  const { user: recruiter, token } = await createRecruiter({ firstName: "Philip" });
  const org = await createOrganization(recruiter, { name: "Kosana Tech" });
  const config = await createAIConfig(recruiter, {
    aiInterview,
    aiInterviewMode: aiInterview ? "audio_video" : null,
  });
  const job = await createJob(recruiter, await createRole("Growth Marketing Manager"), {
    organizationId: org.id,
    aiConfigId: config.id,
  });
  const { user: talent } = await createTalent({ firstName: "Amaka" });
  const application = await createApplication(talent, job);
  return { token, application };
};

const advance = (id: string, token: string, sendInterviewInvite: boolean) =>
  request(app)
    .post(`/v1/applications/${id}/advance`)
    .set("Authorization", `Bearer ${token}`)
    .send({ sendInterviewInvite });

const setStatus = (id: string, token: string, body: Record<string, unknown>) =>
  request(app)
    .patch(`/v1/applications/${id}/status`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);

const statusOf = async (id: string) =>
  (await testDataSource.getRepository(Application).findOneByOrFail({ id })).status;

describe("POST /v1/applications/:id/advance", () => {
  it("shortlists and starts the interview with the invite email", async () => {
    const { token, application } = await setup();

    const res = await advance(application.id, token, true);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ nextStep: "ai_interview", interview: "invited" });
    expect(await statusOf(application.id)).toBe(ApplicationStatus.Shortlisted);
    expect(mockSendInvite).toHaveBeenCalledTimes(1);
    const interview = await testDataSource
      .getRepository(AiInterview)
      .findOneByOrFail({ applicationId: application.id });
    expect(interview.status).toBe("invited");
  });

  it("starts the interview without emailing when the recruiter unticks the invite", async () => {
    const { token, application } = await setup();

    const res = await advance(application.id, token, false);

    expect(res.body.data).toMatchObject({ nextStep: "ai_interview", interview: "ready" });
    expect(mockSendInvite).not.toHaveBeenCalled();
    const interview = await testDataSource
      .getRepository(AiInterview)
      .findOneByOrFail({ applicationId: application.id });
    expect(interview.invitedAt).toBeNull();
  });

  it("only shortlists when the job has no recorded interview", async () => {
    const { token, application } = await setup(false);

    const res = await advance(application.id, token, true);

    expect(res.body.data).toMatchObject({ nextStep: "shortlisted", interview: null });
    expect(await statusOf(application.id)).toBe(ApplicationStatus.Shortlisted);
    expect(mockQuestions).not.toHaveBeenCalled();
  });

  it("can try again after the interview questions failed", async () => {
    const { token, application } = await setup();
    mockQuestions.mockRejectedValueOnce(new Error("AI down"));

    const first = await advance(application.id, token, false);
    expect(first.body.data.interview).toBe("failed");

    const second = await advance(application.id, token, false);
    expect(second.body.data).toMatchObject({ nextStep: "ai_interview", interview: "ready" });
  });

  it("refuses a rejected candidate and another company", async () => {
    const { token, application } = await setup();
    const { token: otherToken } = await createRecruiter();

    expect((await advance(application.id, otherToken, true)).status).toBe(403);

    await testDataSource
      .getRepository(Application)
      .update(application.id, { status: ApplicationStatus.Rejected });
    expect((await advance(application.id, token, true)).status).toBe(400);
    expect(mockQuestions).not.toHaveBeenCalled();
  });
});

describe("PATCH /v1/applications/:id/status with a rejection email", () => {
  it("rejects, saves the message in the chat and emails it", async () => {
    const { token, application } = await setup();
    const body = "Hi Amaka, thank you for applying. We wish you all the best. Philip";

    const res = await setStatus(application.id, token, {
      status: ApplicationStatus.Rejected,
      email: { send: true, body },
    });

    expect(res.status).toBe(200);
    expect(await statusOf(application.id)).toBe(ApplicationStatus.Rejected);
    const messages = await testDataSource
      .getRepository(Message)
      .findBy({ applicationId: application.id });
    expect(messages.map((m) => m.content)).toEqual([body]);
    expect(mockSendApplicantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Update on your application for Growth Marketing Manager",
        recruiterFirstName: "Philip",
        paragraphs: [body],
      })
    );
  });

  it("rejects quietly when the email is unticked", async () => {
    const { token, application } = await setup();

    const res = await setStatus(application.id, token, {
      status: ApplicationStatus.Rejected,
      email: { send: false, body: "" },
    });

    expect(res.status).toBe(200);
    expect(await testDataSource.getRepository(Message).count()).toBe(0);
    expect(mockSendApplicantMessage).not.toHaveBeenCalled();
  });

  it("refuses an email with a shortlist, or an empty email", async () => {
    const { token, application } = await setup();

    const shortlist = await setStatus(application.id, token, {
      status: ApplicationStatus.Shortlisted,
      email: { send: true, body: "Hello" },
    });
    expect(shortlist.status).toBe(400);

    const empty = await setStatus(application.id, token, {
      status: ApplicationStatus.Rejected,
      email: { send: true, body: "   " },
    });
    expect(empty.status).toBe(400);
    expect(await statusOf(application.id)).toBe(ApplicationStatus.Pending);
  });
});
