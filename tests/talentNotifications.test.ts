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
  createCompleteTalent,
  createJob,
  createQuestion,
  createRole,
  validPreAssessment,
} from "./helpers/fixtures.js";
import { Notification, StaffMember } from "../src/entities";
import { ApplicationStatus, QuestionType, ScreeningStage } from "../src/types/enums.js";
import { createStages } from "../src/services/aiConfig.js";
import { notifyTalent, TALENT_NOTIFICATION } from "../src/services/talentNotifications.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { createStaff } from "./helpers/staff.js";
import { apiData } from "./helpers/http.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
    sendStaffInvite: jest.fn().mockResolvedValue(undefined),
    sendApplicationDecision: jest.fn().mockResolvedValue(undefined),
  })),
}));

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
});

const notificationsOf = (userId: string, type?: string) =>
  testDataSource
    .getRepository(Notification)
    .find({ where: { userId, ...(type ? { type } : {}) }, order: { createdAt: "ASC" } });

const SWITCHES = {
  prescreeningAssessment: true,
  cvSimilarity: false,
  personalizedAssessment: false,
  problemSolvingAssessment: true,
  noOfProblemSolvingQuestions: 1,
  cultureFitAssessment: true,
  noOfCultureFitQuestions: 1,
  personalityEvaluation: false,
};

async function openJob() {
  const company = await setupCompany();
  const { stages } = createStages(SWITCHES);
  const config = await createAIConfig(company.owner.user, { ...SWITCHES, stages });
  const job = await createJob(company.owner.user, await createRole("Product Designer"), {
    aiConfigId: config.id,
    organizationId: company.org.id,
  });
  return { ...company, config, stages, job };
}

describe("application notifications", () => {
  it("applying tells the candidate once that their application arrived, linking to it", async () => {
    const { job } = await openJob();
    const { user: talent, token } = await createCompleteTalent(undefined, validPreAssessment());
    const apply = () =>
      request(app).patch(`/v1/jobs/applications/${job.id}`).set(authHeader(token)).send({});

    const res = await apply();
    await apply();

    const received = await notificationsOf(talent.id, TALENT_NOTIFICATION.ApplicationReceived);
    expect(received).toHaveLength(1);
    const { application } = apiData<{ application: { id: string } }>(res);
    expect(received[0]).toMatchObject({
      title: "Your application to Acme Ltd was received",
      message: "Product Designer",
      link: `/talentDashboard/applications/${application.id}`,
    });
  });

  it("finishing problem-solving sends the culture-fit test once, linking straight to it", async () => {
    const { job, stages } = await openJob();
    const { user: talent, token } = await createCompleteTalent();
    const question = await createQuestion(
      QuestionType.ProblemSolving,
      { jobId: job.id },
      { question: "Which option is best here?", options: ["A", "B", "C", "D"], correctOption: 0 }
    );
    const application = await createApplication(talent, job, {
      stages,
      currentStage: ScreeningStage.ProblemSolving,
      problemSolvingQuestions: [question.id],
    });

    const res = await request(app)
      .post("/v1/questions/answer/problem-solving")
      .set(authHeader(token))
      .send({ jobId: job.id, answers: { [question.id]: 0 } });
    expect(res.status).toBe(200);
    await request(app)
      .get(`/v1/user/applications/${application.id}/pipeline`)
      .set(authHeader(token));

    const sent = await notificationsOf(talent.id, TALENT_NOTIFICATION.TestSent);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toBe("Acme Ltd sent you a culture-fit test");
    expect(sent[0]!.message).toMatch(/^Product Designer · due \w{3} \d{1,2} \w{3}$/);
    expect(sent[0]!.link).toBe(`/talentDashboard/applications/${application.id}/test/culture-fit`);
  });

  it("a recruiter's decision is typed and links to the application", async () => {
    const { job, owner } = await openJob();
    const { user: talent } = await createCompleteTalent();
    const application = await createApplication(talent, job);

    const res = await request(app)
      .patch(`/v1/applications/${application.id}/status`)
      .set(authHeader(owner.token))
      .send({ status: ApplicationStatus.Shortlisted });
    expect(res.status).toBeLessThan(300);

    const [update] = await notificationsOf(talent.id, TALENT_NOTIFICATION.ApplicationUpdate);
    expect(update).toMatchObject({
      title: "Congratulations, you've been shortlisted for Product Designer at Acme Ltd",
      link: `/talentDashboard/applications/${application.id}`,
    });
  });

  it("a failure to save a notification never throws", async () => {
    await expect(
      notifyTalent({
        userId: "8b1d3c3e-1b7a-4a59-9a5c-1f0f8f0e2a11",
        type: TALENT_NOTIFICATION.TestSent,
        title: "x",
        message: "y",
      })
    ).resolves.toBeUndefined();
  });
});

describe("profile view notifications", () => {
  it("tells the talent once a day per company, and never for an admin", async () => {
    const { job, owner } = await openJob();
    const { user: talent } = await createCompleteTalent();
    await createApplication(talent, job);

    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .get(`/v1/user/profile/${talent.id}`)
        .set(authHeader(owner.token));
      expect(res.status).toBe(200);
    }

    const viewed = await notificationsOf(talent.id, TALENT_NOTIFICATION.ProfileViewed);
    expect(viewed).toHaveLength(1);
    expect(viewed[0]).toMatchObject({
      title: "Acme Ltd viewed your profile",
      message: "Product Designer",
    });
  });
});

describe("staff invites in My work", () => {
  async function invitedTalent(email: string) {
    const company = await setupCompany();
    const hr = await addMember(company.org, { canManagePeople: true });
    const { user, token } = await createCompleteTalent(await createRole(), { email });
    const staff = await createStaff(app, hr.token, company.org.id, { email, sendInvite: true });
    return { ...company, talent: user, token, staff };
  }

  const mine = (token: string) => request(app).get("/v1/staff-invites/mine").set(authHeader(token));
  const acceptMine = (token: string, staffId: string) =>
    request(app).post(`/v1/staff-invites/mine/${staffId}/accept`).set(authHeader(token));

  it("notifies the invited talent and lists the pending invite", async () => {
    const { talent, token, staff } = await invitedTalent("ada@example.com");

    const [notice] = await notificationsOf(talent.id, TALENT_NOTIFICATION.StaffInvite);
    expect(notice).toMatchObject({
      title: "Acme Ltd added you as staff",
      link: "/talentDashboard/my-work",
    });
    const res = await mine(token);
    expect(res.status).toBe(200);
    expect(apiData<{ invites: unknown[] }>(res).invites).toEqual([
      expect.objectContaining({ id: staff.id, organizationName: "Acme Ltd" }),
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);
  });

  it("accepts from My work, after which nothing is pending", async () => {
    const { talent, token, staff } = await invitedTalent("ada@example.com");

    const res = await acceptMine(token, staff.id);

    expect(res.status).toBe(200);
    const row = await testDataSource.getRepository(StaffMember).findOneByOrFail({ id: staff.id });
    expect(row.userId).toBe(talent.id);
    expect(apiData<{ invites: unknown[] }>(await mine(token)).invites).toEqual([]);
  });

  it("someone else's invite can't be found or accepted", async () => {
    const { staff } = await invitedTalent("ada@example.com");
    const { token: otherToken } = await createCompleteTalent(undefined, {
      email: "bob@example.com",
    });

    expect(apiData<{ invites: unknown[] }>(await mine(otherToken)).invites).toEqual([]);
    expect((await acceptMine(otherToken, staff.id)).status).toBe(404);
    expect((await acceptMine(otherToken, "nope")).status).toBe(400);
  });

  it("an expired invite isn't listed and can't be accepted", async () => {
    const { token, staff } = await invitedTalent("ada@example.com");
    await testDataSource
      .getRepository(StaffMember)
      .update(staff.id, { inviteExpiresAt: new Date(Date.now() - 1000) });

    expect(apiData<{ invites: unknown[] }>(await mine(token)).invites).toEqual([]);
    expect((await acceptMine(token, staff.id)).status).toBe(400);
  });
});
