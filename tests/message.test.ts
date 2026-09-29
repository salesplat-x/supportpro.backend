/**
 * Message tests — bulk/broadcast messaging, chat sessions grouped by job,
 * talent replies (existing threads only), and talent inbox sessions.
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import {
  createTalent,
  createRecruiter,
  createRole,
  createJob,
  createApplication,
  createOrganization,
  createAdmin,
} from "./helpers/fixtures.js";
import { Message } from "../src/entities/Message.js";
import { ApplicationStatus } from "../src/types/enums.js";

const mockSendApplicantMessage = jest.fn().mockResolvedValue(undefined);

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
    sendApplicantMessage: mockSendApplicantMessage,
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
  mockSendApplicantMessage.mockClear().mockResolvedValue(undefined);
});

describe("POST /v1/messages/broadcast — bulk message (item 5)", () => {
  it("messages every applicant on the job when no talentIds are given", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talentA } = await createTalent();
    const { user: talentB } = await createTalent();
    const appA = await createApplication(talentA, job);
    await createApplication(talentB, job);

    const res = await request(app)
      .post("/v1/messages/broadcast")
      .set("Authorization", `Bearer ${token}`)
      .send({ application: appA.id, content: "Hello everyone" });

    expect(res.status).toBe(200);
    const messages = await testDataSource.getRepository(Message).find();
    expect(messages).toHaveLength(2);
  });

  it("only messages the talents in talentIds when provided", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talentA } = await createTalent();
    const { user: talentB } = await createTalent();
    const appA = await createApplication(talentA, job);
    await createApplication(talentB, job);

    const res = await request(app)
      .post("/v1/messages/broadcast")
      .set("Authorization", `Bearer ${token}`)
      .send({ application: appA.id, content: "Just you", talentIds: [talentA.id] });

    expect(res.status).toBe(200);
    const messages = await testDataSource.getRepository(Message).find();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.recipientId).toBe(talentA.id);
  });

  it("messages a non-shortlisted applicant too (bulk path is exempt from the 1:1 shortlisted gate)", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const app_ = await createApplication(talent, job, {
      status: ApplicationStatus.AwaitingDecision,
    });

    const res = await request(app)
      .post("/v1/messages/broadcast")
      .set("Authorization", `Bearer ${token}`)
      .send({ application: app_.id, content: "Still deciding, wanted to reach out" });

    expect(res.status).toBe(200);
    const messages = await testDataSource.getRepository(Message).find();
    expect(messages).toHaveLength(1);
  });
});

describe("POST /v1/messages/broadcast — personalized per-candidate AI messages", () => {
  it("sends each recipient their own drafted content, not one shared message", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talentA } = await createTalent();
    const { user: talentB } = await createTalent();
    const appA = await createApplication(talentA, job);
    const appB = await createApplication(talentB, job);

    const res = await request(app)
      .post("/v1/messages/broadcast")
      .set("Authorization", `Bearer ${token}`)
      .send({
        application: appA.id,
        messages: [
          { applicationId: appA.id, subject: "For A", content: "Hi A, congrats!" },
          { applicationId: appB.id, subject: "For B", content: "Hi B, you're shortlisted!" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sent: 2, emailed: 0, emailFailures: [] });
    const messages = await testDataSource.getRepository(Message).find();
    expect(messages.map((m) => m.content).sort()).toEqual(
      ["Hi A, congrats!", "Hi B, you're shortlisted!"].sort()
    );
    expect(mockSendApplicantMessage).not.toHaveBeenCalled();
  });

  it("with sendEmail, also emails each recipient their own subject/body and reports how many were emailed", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent({ email: "ada@example.com" });
    const application = await createApplication(talent, job);

    const res = await request(app)
      .post("/v1/messages/broadcast")
      .set("Authorization", `Bearer ${token}`)
      .send({
        application: application.id,
        messages: [{ applicationId: application.id, subject: "You're shortlisted!", content: "Hi Ada,\n\nGreat news." }],
        sendEmail: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sent: 1, emailed: 1, emailFailures: [] });
    expect(mockSendApplicantMessage).toHaveBeenCalledTimes(1);
    expect(mockSendApplicantMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ada@example.com",
        subject: "You're shortlisted!",
        paragraphs: ["Hi Ada,", "Great news."],
      })
    );
  });

  it("records a per-recipient email failure without failing the whole request or losing the in-app message", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talentA } = await createTalent();
    const { user: talentB } = await createTalent();
    const appA = await createApplication(talentA, job);
    const appB = await createApplication(talentB, job);
    mockSendApplicantMessage.mockRejectedValueOnce(new Error("Resend is down"));

    const res = await request(app)
      .post("/v1/messages/broadcast")
      .set("Authorization", `Bearer ${token}`)
      .send({
        application: appA.id,
        messages: [
          { applicationId: appA.id, content: "Hi A" },
          { applicationId: appB.id, content: "Hi B" },
        ],
        sendEmail: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.sent).toBe(2);
    expect(res.body.data.emailed).toBe(1);
    expect(res.body.data.emailFailures).toEqual([
      { applicationId: appA.id, error: "Resend is down" },
    ]);
    // The in-app message still went out for the one whose email failed.
    const messages = await testDataSource.getRepository(Message).find();
    expect(messages).toHaveLength(2);
  });

  it("skips a recipient whose drafted content is blank rather than sending an empty message", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const application = await createApplication(talent, job);

    const res = await request(app)
      .post("/v1/messages/broadcast")
      .set("Authorization", `Bearer ${token}`)
      .send({ application: application.id, messages: [{ applicationId: application.id, content: "" }] });

    expect(res.status).toBe(200);
    expect(res.body.data.sent).toBe(0);
    expect(await testDataSource.getRepository(Message).count()).toBe(0);
  });

  it("ignores a messages entry for an applicationId on a different job", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const jobA = await createJob(recruiter, role);
    const jobB = await createJob(recruiter, role);
    const { user: talentA } = await createTalent();
    const { user: talentB } = await createTalent();
    const appA = await createApplication(talentA, jobA);
    const foreignApp = await createApplication(talentB, jobB);

    const res = await request(app)
      .post("/v1/messages/broadcast")
      .set("Authorization", `Bearer ${token}`)
      .send({
        application: appA.id,
        messages: [
          { applicationId: appA.id, content: "Hi A" },
          { applicationId: foreignApp.id, content: "Hi wrong job" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.sent).toBe(1);
    const messages = await testDataSource.getRepository(Message).find();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.recipientId).toBe(talentA.id);
  });

  it("messages takes priority over content/talentIds when both are supplied", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talentA } = await createTalent();
    const { user: talentB } = await createTalent();
    const appA = await createApplication(talentA, job);
    await createApplication(talentB, job);

    const res = await request(app)
      .post("/v1/messages/broadcast")
      .set("Authorization", `Bearer ${token}`)
      .send({
        application: appA.id,
        content: "Generic message to everyone",
        messages: [{ applicationId: appA.id, content: "Personalized for A only" }],
      });

    expect(res.status).toBe(200);
    const messages = await testDataSource.getRepository(Message).find();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("Personalized for A only");
  });

  it.each([
    ["neither content nor messages", {}],
    ["an empty messages array", { messages: [] }],
  ])("400s when given %s", async (_label, extra) => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    const application = await createApplication(talent, job);

    const res = await request(app)
      .post("/v1/messages/broadcast")
      .set("Authorization", `Bearer ${token}`)
      .send({ application: application.id, ...extra });

    expect(res.status).toBe(400);
    expect(mockSendApplicantMessage).not.toHaveBeenCalled();
  });
});

describe("POST /v1/messages/ — talent replies, not new threads", () => {
  it("rejects a talent starting a conversation with a recruiter they have never been messaged by", async () => {
    const { user: talent, token: talentToken } = await createTalent();
    const { user: recruiter } = await createRecruiter();

    const res = await request(app)
      .post("/v1/messages/")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({ content: "Can I have this job please", recipient: recruiter.id });

    expect(res.status).toBe(403);
    expect(talent).toBeDefined();
  });

  it("lets a talent reply once the recruiter has opened the thread", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent, token: talentToken } = await createTalent();
    const application = await createApplication(talent, job, {
      status: ApplicationStatus.Shortlisted,
    });

    await request(app)
      .post("/v1/messages/")
      .set("Authorization", `Bearer ${recruiterToken}`)
      .send({ content: "Congrats!", recipient: talent.id, application: application.id });

    const res = await request(app)
      .post("/v1/messages/")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({
        content: "Thank you, I am interested.",
        recipient: recruiter.id,
        application: application.id,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.message.content).toBe("Thank you, I am interested.");
  });

  it("a recruiter's POST still succeeds", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent } = await createTalent();
    await createApplication(talent, job, { status: ApplicationStatus.Shortlisted });

    const res = await request(app)
      .post("/v1/messages/")
      .set("Authorization", `Bearer ${token}`)
      .send({ content: "Congrats!", recipient: talent.id });

    expect(res.status).toBe(201);
  });
});

describe("GET /v1/messages/ — talent inbox", () => {
  it("returns a message the recruiter sent, with a correct unread count (no 500)", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent, token: talentToken } = await createTalent();
    const application = await createApplication(talent, job, {
      status: ApplicationStatus.Shortlisted,
    });

    await request(app)
      .post("/v1/messages/")
      .set("Authorization", `Bearer ${recruiterToken}`)
      .send({ content: "You're shortlisted!", recipient: talent.id, application: application.id });

    const res = await request(app)
      .get("/v1/messages/")
      .set("Authorization", `Bearer ${talentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.messages).toHaveLength(1);
    expect(res.body.data.messages[0].content).toBe("You're shortlisted!");
    expect(res.body.data.unReadCount).toBe(1);
    expect(res.body.data.messages[0].sender.firstName).toBe(recruiter.firstName);
    expect(res.body.data.messages[0].sender.userRole).toBe("recruiter");
  });

  it("marks inbound messages read when the talent opens the thread", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter();
    const role = await createRole();
    const job = await createJob(recruiter, role);
    const { user: talent, token: talentToken } = await createTalent();
    const application = await createApplication(talent, job, {
      status: ApplicationStatus.Shortlisted,
    });

    await request(app)
      .post("/v1/messages/")
      .set("Authorization", `Bearer ${recruiterToken}`)
      .send({ content: "You're shortlisted!", recipient: talent.id, application: application.id });

    const opened = await request(app)
      .get(`/v1/messages/?application=${application.id}`)
      .set("Authorization", `Bearer ${talentToken}`);

    expect(opened.status).toBe(200);
    expect(opened.body.data.unReadCount).toBe(0);

    const inbox = await request(app)
      .get("/v1/messages/")
      .set("Authorization", `Bearer ${talentToken}`);

    expect(inbox.body.data.unReadCount).toBe(0);
  });
});

describe("GET /v1/messages/sessions — recruiter chat list grouped by job (item 8)", () => {
  it("groups threads by job and reports unread counts", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const role = await createRole();
    const jobA = await createJob(recruiter, role);
    const jobB = await createJob(recruiter, role);
    const { user: talentA } = await createTalent();
    const { user: talentB } = await createTalent();
    const appA = await createApplication(talentA, jobA, { status: ApplicationStatus.Shortlisted });
    const appB = await createApplication(talentB, jobB, { status: ApplicationStatus.Shortlisted });

    await request(app)
      .post("/v1/messages/")
      .set("Authorization", `Bearer ${token}`)
      .send({ content: "Hi A", recipient: talentA.id, application: appA.id });
    await request(app)
      .post("/v1/messages/")
      .set("Authorization", `Bearer ${token}`)
      .send({ content: "Hi B", recipient: talentB.id, application: appB.id });

    const res = await request(app)
      .get("/v1/messages/sessions")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const sessions = res.body.data.sessions;
    expect(sessions).toHaveLength(2);
    const jobIds = sessions.map((s: { jobId: string }) => s.jobId).sort();
    expect(jobIds).toEqual([jobA.id, jobB.id].sort());
  });

  it("only includes the caller's own applicants", async () => {
    const { user: recruiterA, token: tokenA } = await createRecruiter();
    const { user: recruiterB } = await createRecruiter();
    const role = await createRole();
    const jobA = await createJob(recruiterA, role);
    const jobB = await createJob(recruiterB, role);
    const { user: talentA } = await createTalent();
    const { user: talentB } = await createTalent();
    const appA = await createApplication(talentA, jobA, { status: ApplicationStatus.Shortlisted });
    await createApplication(talentB, jobB, { status: ApplicationStatus.Shortlisted });

    await request(app)
      .post("/v1/messages/")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ content: "Hi", recipient: talentA.id, application: appA.id });

    const res = await request(app)
      .get("/v1/messages/sessions")
      .set("Authorization", `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.data.sessions).toHaveLength(1);
    expect(res.body.data.sessions[0].jobId).toBe(jobA.id);
    expect(res.body.data.sessions[0].threads[0].lastMessagePreview).toBe("Hi");
  });
});

describe("GET /v1/messages/sessions — talent inbox threads", () => {
  it("returns recruiter name, company, and last message preview", async () => {
    const { user: recruiter, token: recruiterToken } = await createRecruiter({
      firstName: "Jane",
      lastName: "Recruiter",
    });
    const org = await createOrganization(recruiter, { name: "Acme Corp" });
    const role = await createRole();
    const job = await createJob(recruiter, role, { organizationId: org.id });
    const { user: talent, token: talentToken } = await createTalent();
    const application = await createApplication(talent, job, {
      status: ApplicationStatus.Shortlisted,
    });

    await request(app)
      .post("/v1/messages/")
      .set("Authorization", `Bearer ${recruiterToken}`)
      .send({ content: "Let's chat", recipient: talent.id, application: application.id });

    const res = await request(app)
      .get("/v1/messages/sessions")
      .set("Authorization", `Bearer ${talentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.sessions).toHaveLength(1);
    expect(res.body.data.sessions[0]).toMatchObject({
      applicationId: application.id,
      recruiterId: recruiter.id,
      recruiterName: "Jane Recruiter",
      companyName: "Acme Corp",
      lastMessagePreview: "Let's chat",
      unreadCount: 1,
    });
  });
});

describe("Admin messaging a talent directly (no job application)", () => {
  it("lets an admin start a conversation with a talent and read it back by participantId", async () => {
    const { user: admin, token: adminToken } = await createAdmin();
    const { user: talent, token: talentToken } = await createTalent();

    const sendRes = await request(app)
      .post("/v1/messages/")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ content: "Welcome to the platform", recipient: talent.id });
    expect(sendRes.status).toBe(201);

    const adminView = await request(app)
      .get(`/v1/messages?participantId=${talent.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(adminView.status).toBe(200);
    expect(adminView.body.data.messages).toHaveLength(1);
    expect(adminView.body.data.messages[0].content).toBe("Welcome to the platform");

    const talentView = await request(app)
      .get(`/v1/messages?participantId=${admin.id}`)
      .set("Authorization", `Bearer ${talentToken}`);
    expect(talentView.status).toBe(200);
    expect(talentView.body.data.messages).toHaveLength(1);
  });

  it("returns an empty thread when no conversation exists yet for that participant", async () => {
    const { token: adminToken } = await createAdmin();
    const { user: talent } = await createTalent();

    const res = await request(app)
      .get(`/v1/messages?participantId=${talent.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.messages).toHaveLength(0);
  });
});
