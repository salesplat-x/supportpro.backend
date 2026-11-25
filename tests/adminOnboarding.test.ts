import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { OnboardingEmail } from "../src/entities/OnboardingEmail.js";
import { Organization } from "../src/entities/Organization.js";
import { User } from "../src/entities/User.js";
import { Role } from "../src/entities/Role.js";
import { BillingStatus, JobStatus, PaymentStatus } from "../src/types/enums.js";
import { composeOnboardingEmail } from "../src/utils/integrations/openai.js";
import {
  createAdmin,
  createAIConfig,
  createApplication,
  createCompleteTalent,
  createJob,
  createOrganization,
  createPayment,
  createRecruiter,
  createRole,
  createTalent,
  validPreAssessment,
} from "./helpers/fixtures.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
  composeOnboardingEmail: jest.fn(),
}));

const mockSendFollowUp = jest.fn();

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
    sendPasswordReset: jest.fn().mockResolvedValue(undefined),
    sendOnboardingFollowUp: mockSendFollowUp,
  })),
}));

const mockCompose = composeOnboardingEmail as jest.Mock;

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

beforeEach(() => {
  mockSendFollowUp.mockReset().mockResolvedValue(undefined);
  mockCompose
    .mockReset()
    .mockResolvedValue(aiReply({ subject: "Your next step on Auxhr", body: "Hi!\nCome back." }));
});

afterEach(async () => {
  await clearAllTables();
});

const orgRepo = () => testDataSource.getRepository(Organization);
const emailRepo = () => testDataSource.getRepository(OnboardingEmail);

// ---- Seeding helpers ------------------------------------------------------------------

async function seedTalents(role: Role) {
  const recruiter = (await createRecruiter()).user;
  const job = await createJob(recruiter, role);
  const verifyEmail = (await createTalent({ emailVerifiedAt: null })).user;
  const noCv = (await createTalent()).user;
  const blankCvName = (await createTalent({ cvFileName: "" })).user;
  const cvNoRoles = (await createCompleteTalent()).user;
  const takeAssessment = (await createCompleteTalent(role)).user;
  const applyToJob = (await createCompleteTalent(role, validPreAssessment(70))).user;
  const zeroScore = (await createCompleteTalent(role, validPreAssessment(0))).user;
  const active = (await createCompleteTalent(role, validPreAssessment(80))).user;
  await createApplication(active, job);
  return {
    verify_email: [verifyEmail],
    complete_profile: [noCv, blankCvName, cvNoRoles],
    take_assessment: [takeAssessment],
    apply_to_job: [applyToJob, zeroScore],
    active: [active],
  };
}

async function recruiterWithCompany(overrides: Partial<Organization> = {}) {
  const { user } = await createRecruiter();
  const org = await createOrganization(user, overrides);
  return { user: { ...user, activeOrganizationId: org.id } as User, org };
}

async function seedRecruiters(role: Role) {
  const verifyEmail = (await createRecruiter({ emailVerifiedAt: null })).user;
  const createCompany = (await createRecruiter()).user;
  const postJob = (await recruiterWithCompany()).user;

  const setUpScreening = await recruiterWithCompany();
  await createJob(setUpScreening.user, role, {
    status: JobStatus.Draft,
    organizationId: setUpScreening.org.id,
  });

  const publishJob = await recruiterWithCompany();
  const draft = await createJob(publishJob.user, role, {
    status: JobStatus.Draft,
    organizationId: publishJob.org.id,
    aiConfigId: (await createAIConfig(publishJob.user)).id,
  });
  await createPayment(publishJob.user, undefined, {
    status: PaymentStatus.Pending,
    initialConfig: { metadata: { jobId: draft.id } },
  });

  const planPurchaseOnly = await recruiterWithCompany();
  await createJob(planPurchaseOnly.user, role, {
    status: JobStatus.Draft,
    organizationId: planPurchaseOnly.org.id,
    aiConfigId: (await createAIConfig(planPurchaseOnly.user)).id,
  });
  await createPayment(planPurchaseOnly.user, undefined, {
    status: PaymentStatus.Completed,
    reference: `REF_PLAN_${Date.now()}`,
    initialConfig: { metadata: { planKey: "pro" } },
  });

  const paidJob = await recruiterWithCompany();
  const paid = await createJob(paidJob.user, role, {
    organizationId: paidJob.org.id,
    aiConfigId: (await createAIConfig(paidJob.user)).id,
  });
  await createPayment(paidJob.user, undefined, {
    status: PaymentStatus.Completed,
    reference: `REF_JOB_${Date.now()}`,
    initialConfig: { metadata: { jobId: paid.id } },
  });

  const paidByTeammate = await recruiterWithCompany();
  const teammate = (await createRecruiter()).user;
  const teammatePaid = await createJob(paidByTeammate.user, role, {
    organizationId: paidByTeammate.org.id,
    aiConfigId: (await createAIConfig(paidByTeammate.user)).id,
  });
  await createPayment(teammate, undefined, {
    status: PaymentStatus.Completed,
    reference: `REF_TEAM_${Date.now()}`,
    initialConfig: { metadata: { jobId: teammatePaid.id } },
  });

  const onPlan = (
    await recruiterWithCompany({
      billingPlan: "pro",
      billingStatus: BillingStatus.Active,
      billingPeriodEnd: new Date(Date.now() + 10 * 86_400_000),
    })
  ).user;
  const pastDue = (
    await recruiterWithCompany({ billingPlan: "pro", billingStatus: BillingStatus.PastDue })
  ).user;
  const expired = (
    await recruiterWithCompany({
      billingPlan: "pro",
      billingStatus: BillingStatus.Active,
      billingPeriodEnd: new Date(Date.now() - 86_400_000),
    })
  ).user;

  return {
    verify_email: [verifyEmail],
    create_company: [createCompany],
    post_job: [postJob, pastDue, expired],
    set_up_screening: [setUpScreening.user],
    publish_job: [publishJob.user, planPurchaseOnly.user],
    active: [paidJob.user, paidByTeammate.user, onPlan],
    teammate,
  };
}

const listAs = (token: string, path: string) =>
  request(app).get(path).set("Authorization", `Bearer ${token}`);

const stageById = (users: Array<{ id: string; onboarding: { stage: string } }>) =>
  Object.fromEntries(users.map((user) => [user.id, user.onboarding.stage]));

// ---- Lists ----------------------------------------------------------------------------

describe("GET /v1/admin/talents — onboarding", () => {
  it("reports each talent's stage", async () => {
    const { token } = await createAdmin();
    const seeded = await seedTalents(await createRole());

    const res = await listAs(token, "/v1/admin/talents?limit=200");

    expect(res.status).toBe(200);
    const stages = stageById(res.body.data.users);
    for (const [stage, users] of Object.entries(seeded)) {
      for (const user of users) {
        expect({ id: user.id, stage: stages[user.id] }).toEqual({ id: user.id, stage });
      }
    }
    expect(res.body.data.users[0].onboarding).toEqual(
      expect.objectContaining({ emailsSent: 0, lastEmailAt: null, followUp: "none" })
    );
  });

  it("keeps every existing field in the response", async () => {
    const { token } = await createAdmin();
    await createCompleteTalent(await createRole());

    const res = await listAs(token, "/v1/admin/talents");

    expect(res.body.data).toEqual(expect.objectContaining({ total: 1, users: expect.any(Array) }));
    expect(Object.keys(res.body.data.users[0])).toEqual(
      expect.arrayContaining([
        "id",
        "email",
        "firstName",
        "lastName",
        "experience",
        "prescreeningScore",
        "cvFileName",
        "createdAt",
        "userRoles",
        "onboarding",
      ])
    );
    expect(res.body.data.users[0]).not.toHaveProperty("cvText");
  });

  it.each(["verify_email", "complete_profile", "take_assessment", "apply_to_job", "active"])(
    "filters by the %s stage, agreeing with the stage shown on each row",
    async (stage) => {
      const { token } = await createAdmin();
      await seedTalents(await createRole());

      const all = await listAs(token, "/v1/admin/talents?limit=200");
      const filtered = await listAs(token, `/v1/admin/talents?limit=200&onboardingStage=${stage}`);

      expect(filtered.status).toBe(200);
      const expected = all.body.data.users
        .filter((user: { onboarding: { stage: string } }) => user.onboarding.stage === stage)
        .map((user: { id: string }) => user.id)
        .sort();
      expect(filtered.body.data.users.map((user: { id: string }) => user.id).sort()).toEqual(
        expected
      );
      expect(filtered.body.data.total).toBe(expected.length);
    }
  );

  it("SQL filter and row stage agree for random profiles", async () => {
    const { token } = await createAdmin();
    const role = await createRole();
    const recruiter = (await createRecruiter()).user;
    const job = await createJob(recruiter, role);
    let seed = 7;
    const coin = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280 > 0.5;
    };
    for (let i = 0; i < 16; i += 1) {
      const { user } = await createTalent({
        emailVerifiedAt: coin() ? new Date() : null,
        cvFileName: coin() ? "cv.pdf" : null,
        ...(coin() ? validPreAssessment(55) : { prescreeningScore: null }),
      });
      if (coin()) {
        user.userRoles = [role];
        await testDataSource.getRepository(User).save(user);
      }
      if (coin()) await createApplication(user, job);
    }

    const all = await listAs(token, "/v1/admin/talents?limit=200");
    for (const stage of [
      "verify_email",
      "complete_profile",
      "take_assessment",
      "apply_to_job",
      "active",
    ]) {
      const filtered = await listAs(token, `/v1/admin/talents?limit=200&onboardingStage=${stage}`);
      const expected = all.body.data.users
        .filter((user: { onboarding: { stage: string } }) => user.onboarding.stage === stage)
        .map((user: { id: string }) => user.id)
        .sort();
      expect(filtered.body.data.users.map((user: { id: string }) => user.id).sort()).toEqual(
        expected
      );
    }
  });

  it("combines onboarding filters with search and paginates the filtered list", async () => {
    const { token } = await createAdmin();
    const role = await createRole();
    await createCompleteTalent(role, { firstName: "Ada" });
    await createCompleteTalent(role, { firstName: "Ada" });
    await createCompleteTalent(role, { firstName: "Bola" });
    await createTalent({ firstName: "Ada" });

    const res = await listAs(
      token,
      "/v1/admin/talents?search=ada&onboardingStage=take_assessment&limit=1&offset=0"
    );

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.users).toHaveLength(1);
    expect(res.body.data.users[0].firstName).toBe("Ada");
  });

  it("rejects an unknown or recruiter-only stage, and an unknown follow-up status", async () => {
    const { token } = await createAdmin();
    expect((await listAs(token, "/v1/admin/talents?onboardingStage=nope")).status).toBe(400);
    expect((await listAs(token, "/v1/admin/talents?onboardingStage=post_job")).status).toBe(400);
    expect((await listAs(token, "/v1/admin/talents?followUp=maybe")).status).toBe(400);
  });

  it("never lists recruiters among talents", async () => {
    const { token } = await createAdmin();
    await createRecruiter({ emailVerifiedAt: null });
    const res = await listAs(token, "/v1/admin/talents?onboardingStage=verify_email");
    expect(res.body.data.users).toHaveLength(0);
  });
});

describe("GET /v1/admin/recruiters — onboarding", () => {
  it("reports each recruiter's stage, including plan and payment rules", async () => {
    const { token } = await createAdmin();
    const { teammate, ...seeded } = await seedRecruiters(await createRole());

    const res = await listAs(token, "/v1/admin/recruiters?limit=200");

    expect(res.status).toBe(200);
    const stages = stageById(res.body.data.users);
    for (const [stage, users] of Object.entries(seeded)) {
      for (const user of users) {
        expect({ id: user.id, stage: stages[user.id] }).toEqual({ id: user.id, stage });
      }
    }
    expect(stages[teammate.id]).toBe("create_company");
  });

  it.each([
    "verify_email",
    "create_company",
    "post_job",
    "set_up_screening",
    "publish_job",
    "active",
  ])("filters by the %s stage, agreeing with the stage shown on each row", async (stage) => {
    const { token } = await createAdmin();
    await seedRecruiters(await createRole());

    const all = await listAs(token, "/v1/admin/recruiters?limit=200");
    const filtered = await listAs(token, `/v1/admin/recruiters?limit=200&onboardingStage=${stage}`);

    expect(filtered.status).toBe(200);
    const expected = all.body.data.users
      .filter((user: { onboarding: { stage: string } }) => user.onboarding.stage === stage)
      .map((user: { id: string }) => user.id)
      .sort();
    expect(expected.length).toBeGreaterThan(0);
    expect(filtered.body.data.users.map((user: { id: string }) => user.id).sort()).toEqual(
      expected
    );
  });

  it("rejects a talent-only stage", async () => {
    const { token } = await createAdmin();
    expect(
      (await listAs(token, "/v1/admin/recruiters?onboardingStage=take_assessment")).status
    ).toBe(400);
  });

  it("never lists talents among recruiters", async () => {
    const { token } = await createAdmin();
    await createTalent({ emailVerifiedAt: null });
    const res = await listAs(token, "/v1/admin/recruiters?onboardingStage=verify_email");
    expect(res.body.data.users).toHaveLength(0);
  });
});

// ---- Single user ----------------------------------------------------------------------

const onboardingPath = (id: string) => `/v1/admin/users/${id}/onboarding`;

describe("GET /v1/admin/users/:_id/onboarding", () => {
  it("returns a talent's steps, stage and next steps", async () => {
    const { token } = await createAdmin();
    const { user } = await createCompleteTalent(await createRole());

    const res = await listAs(token, onboardingPath(user.id));

    expect(res.status).toBe(200);
    const onboarding = res.body.data.onboarding;
    expect(onboarding).toEqual(
      expect.objectContaining({ userId: user.id, role: "talent", stage: "take_assessment" })
    );
    expect(onboarding.steps.map((s: { key: string; done: boolean }) => [s.key, s.done])).toEqual([
      ["verify_email", true],
      ["complete_profile", true],
      ["take_assessment", false],
      ["apply_to_job", false],
    ]);
    expect(onboarding.nextSteps.ctaPath).toBe("/talentDashboard/talentQuiz");
    expect(onboarding.emails).toEqual([]);
  });

  it("returns a recruiter's steps", async () => {
    const { token } = await createAdmin();
    const { user } = await recruiterWithCompany();

    const res = await listAs(token, onboardingPath(user.id));

    expect(res.body.data.onboarding.role).toBe("recruiter");
    expect(res.body.data.onboarding.stage).toBe("post_job");
    expect(res.body.data.onboarding.steps).toHaveLength(5);
  });

  it("lists sent and failed emails, newest first", async () => {
    const { user: admin, token } = await createAdmin();
    const { user } = await createTalent();
    const older = await emailRepo().save(
      emailRepo().create({
        userId: user.id,
        sentById: admin.id,
        stage: "complete_profile",
        subject: "Older",
        body: "b",
        status: "sent",
      })
    );
    await emailRepo().update(older.id, { createdAt: new Date(Date.now() - 3 * 86_400_000) });
    await emailRepo().save(
      emailRepo().create({
        userId: user.id,
        sentById: admin.id,
        stage: "complete_profile",
        subject: "Newer",
        body: "b",
        status: "failed",
        error: "bounced",
      })
    );

    const res = await listAs(token, onboardingPath(user.id));

    expect(res.body.data.onboarding.emails.map((e: { subject: string }) => e.subject)).toEqual([
      "Newer",
      "Older",
    ]);
    expect(res.body.data.onboarding.emails[0].status).toBe("failed");
    expect(res.body.data.onboarding.followUp).toBe("emailed");
  });

  it("404s for an unknown user and 400s for a malformed id", async () => {
    const { token } = await createAdmin();
    expect(
      (await listAs(token, onboardingPath("6f1c7a1e-8a3b-4c2d-9e0f-1a2b3c4d5e6f"))).status
    ).toBe(404);
    expect((await listAs(token, onboardingPath("not-a-uuid"))).status).toBe(400);
  });

  it("400s for an admin account", async () => {
    const { user: admin, token } = await createAdmin();
    expect((await listAs(token, onboardingPath(admin.id))).status).toBe(400);
  });
});

// ---- Draft ----------------------------------------------------------------------------

const draftAs = (token: string, id: string) =>
  request(app)
    .post(`${onboardingPath(id)}/draft`)
    .set("Authorization", `Bearer ${token}`);

describe("POST /v1/admin/users/:_id/onboarding/draft", () => {
  it("returns an AI draft built from the user's stage and next steps", async () => {
    const { token } = await createAdmin();
    const { user } = await createCompleteTalent(await createRole(), { firstName: "Ada" });

    const res = await draftAs(token, user.id);

    expect(res.status).toBe(200);
    expect(res.body.data.draft).toEqual({
      subject: "Your next step on Auxhr",
      body: "Hi!\nCome back.",
    });
    const context = mockCompose.mock.calls[0][0];
    expect(context).toEqual(
      expect.objectContaining({
        firstName: "Ada",
        role: "talent",
        stage: "take_assessment",
        ctaLabel: "Take the pre-assessment",
        previousEmails: [],
      })
    );
    expect(context.nextSteps.length).toBeGreaterThan(0);
    expect(await emailRepo().count()).toBe(0);
  });

  it("tells the AI about earlier emails so it writes a follow-up", async () => {
    const { user: admin, token } = await createAdmin();
    const { user } = await createTalent();
    await emailRepo().save(
      emailRepo().create({
        userId: user.id,
        sentById: admin.id,
        stage: "complete_profile",
        subject: "Finish your profile",
        body: "b",
        status: "sent",
      })
    );

    await draftAs(token, user.id);

    expect(mockCompose.mock.calls[0][0].previousEmails).toEqual([
      expect.objectContaining({ subject: "Finish your profile" }),
    ]);
  });

  it("returns 502 and stores nothing when the AI is down", async () => {
    const { token } = await createAdmin();
    const { user } = await createTalent();
    mockCompose.mockRejectedValue(new Error("timeout"));

    const res = await draftAs(token, user.id);

    expect(res.status).toBe(502);
    expect(res.body.error.message).toMatch(/couldn't write an email/i);
    expect(await emailRepo().count()).toBe(0);
  });

  it("returns 400 for an unreadable AI draft", async () => {
    const { token } = await createAdmin();
    const { user } = await createTalent();
    mockCompose.mockResolvedValue(aiReply("Dear user, ..."));

    expect((await draftAs(token, user.id)).status).toBe(400);
  });

  it("refuses to draft for a user who isn't stuck", async () => {
    const { token } = await createAdmin();
    const role = await createRole();
    const job = await createJob((await createRecruiter()).user, role);
    const { user } = await createCompleteTalent(role, validPreAssessment(80));
    await createApplication(user, job);

    const res = await draftAs(token, user.id);

    expect(res.status).toBe(400);
    expect(mockCompose).not.toHaveBeenCalled();
  });
});

// ---- Send -----------------------------------------------------------------------------

const sendAs = (token: string, id: string, body: Record<string, unknown>) =>
  request(app)
    .post(`${onboardingPath(id)}/emails`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);

const EMAIL = { subject: "Your next step", body: "Hi Ada,\n\nOne quick step left." };

describe("POST /v1/admin/users/:_id/onboarding/emails", () => {
  it("sends the email and records it with the stage, sender and time", async () => {
    const { user: admin, token } = await createAdmin();
    const { user } = await createTalent({ email: "ada@example.com" });

    const res = await sendAs(token, user.id, EMAIL);

    expect(res.status).toBe(201);
    expect(res.body.data.email).toEqual(
      expect.objectContaining({
        userId: user.id,
        sentById: admin.id,
        stage: "complete_profile",
        subject: "Your next step",
        status: "sent",
        error: null,
      })
    );
    expect(new Date(res.body.data.email.createdAt).getTime()).toBeLessThanOrEqual(Date.now());
    expect(mockSendFollowUp).toHaveBeenCalledWith({
      to: "ada@example.com",
      subject: "Your next step",
      paragraphs: ["Hi Ada,", "One quick step left."],
      ctaLabel: "Finish your profile",
      ctaUrl: expect.stringMatching(/\/talentDashboard\/talentProfile$/),
    });
  });

  it("asks for confirmation before a second email within 24 hours", async () => {
    const { token } = await createAdmin();
    const { user } = await createTalent();
    await sendAs(token, user.id, EMAIL);

    const blocked = await sendAs(token, user.id, EMAIL);
    expect(blocked.status).toBe(409);
    expect(await emailRepo().count()).toBe(1);

    const confirmed = await sendAs(token, user.id, { ...EMAIL, confirm: true });
    expect(confirmed.status).toBe(201);
    expect(await emailRepo().count()).toBe(2);
  });

  it("needs no confirmation once 24 hours have passed", async () => {
    const { token } = await createAdmin();
    const { user } = await createTalent();
    const first = await sendAs(token, user.id, EMAIL);
    await emailRepo().update(first.body.data.email.id, {
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    expect((await sendAs(token, user.id, EMAIL)).status).toBe(201);
  });

  it("records a failed send honestly and does not count it for the 24-hour rule", async () => {
    const { token } = await createAdmin();
    const { user } = await createTalent();
    mockSendFollowUp.mockRejectedValueOnce(new Error("Resend is down"));

    const failed = await sendAs(token, user.id, EMAIL);

    expect(failed.status).toBe(502);
    const rows = await emailRepo().find();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ status: "failed", error: "Resend is down" }));

    const retry = await sendAs(token, user.id, EMAIL);
    expect(retry.status).toBe(201);

    const list = await listAs(token, "/v1/admin/talents");
    expect(list.body.data.users[0].onboarding).toEqual(
      expect.objectContaining({ emailsSent: 1, followUp: "emailed" })
    );
  });

  it.each([
    ["an empty subject", { subject: "  ", body: "Hi" }],
    ["an empty body", { subject: "Hi", body: "" }],
    ["a missing body", { subject: "Hi" }],
    ["a subject that is too long", { subject: "s".repeat(151), body: "Hi" }],
    ["a body that is too long", { subject: "Hi", body: "b".repeat(5001) }],
    ["a non-boolean confirm", { ...EMAIL, confirm: "yes please" }],
  ])("rejects %s", async (_label, payload) => {
    const { token } = await createAdmin();
    const { user } = await createTalent();

    const res = await sendAs(token, user.id, payload);

    expect(res.status).toBe(400);
    expect(mockSendFollowUp).not.toHaveBeenCalled();
    expect(await emailRepo().count()).toBe(0);
  });

  it("refuses to email a user who isn't stuck", async () => {
    const { token } = await createAdmin();
    const { user } = await recruiterWithCompany({
      billingPlan: "pro",
      billingStatus: BillingStatus.Active,
    });

    expect((await sendAs(token, user.id, EMAIL)).status).toBe(400);
    expect(mockSendFollowUp).not.toHaveBeenCalled();
  });

  it("shows the user as progressed once they finish the step they were emailed about", async () => {
    const { token } = await createAdmin();
    const role = await createRole();
    const { user } = await createCompleteTalent(role);
    await sendAs(token, user.id, EMAIL);

    const before = await listAs(token, "/v1/admin/talents?followUp=emailed");
    expect(before.body.data.users.map((u: { id: string }) => u.id)).toEqual([user.id]);

    await testDataSource.getRepository(User).update(user.id, validPreAssessment(75));

    const after = await listAs(token, "/v1/admin/talents?followUp=progressed");
    expect(after.body.data.users.map((u: { id: string }) => u.id)).toEqual([user.id]);
    expect(after.body.data.users[0].onboarding.followUp).toBe("progressed");
    expect((await listAs(token, "/v1/admin/talents?followUp=none")).body.data.users).toHaveLength(
      0
    );
  });
});

// ---- Access and deletion --------------------------------------------------------------

describe("onboarding access and cleanup", () => {
  const routes = (id: string) => [
    () => request(app).get("/v1/admin/talents?onboardingStage=verify_email"),
    () => request(app).get("/v1/admin/recruiters?followUp=none"),
    () => request(app).get(onboardingPath(id)),
    () => request(app).post(`${onboardingPath(id)}/draft`),
    () =>
      request(app)
        .post(`${onboardingPath(id)}/emails`)
        .send(EMAIL),
  ];

  it("requires a signed-in, verified admin for every route", async () => {
    const { user: target } = await createTalent();
    const { token: talentToken } = await createTalent();
    const { token: recruiterToken } = await createRecruiter();
    const { token: unverifiedAdmin } = await createAdmin({ emailVerifiedAt: null });

    for (const call of routes(target.id)) {
      expect((await call()).status).toBe(401);
      expect((await call().set("Authorization", `Bearer ${talentToken}`)).status).toBe(403);
      expect((await call().set("Authorization", `Bearer ${recruiterToken}`)).status).toBe(403);
      expect((await call().set("Authorization", `Bearer ${unverifiedAdmin}`)).status).toBe(403);
    }
    expect(mockSendFollowUp).not.toHaveBeenCalled();
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it("removes a deleted talent's follow-up emails", async () => {
    const { token } = await createAdmin();
    const { user } = await createTalent();
    await sendAs(token, user.id, EMAIL);

    const res = await request(app)
      .delete(`/v1/admin/talents/${user.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(await emailRepo().count()).toBe(0);
  });

  it("removes a deleted recruiter's follow-up emails", async () => {
    const { token } = await createAdmin();
    const { user } = await createRecruiter();
    await sendAs(token, user.id, EMAIL);

    const res = await request(app)
      .delete(`/v1/admin/recruiters/${user.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(await emailRepo().count()).toBe(0);
  });

  it("keeps the history when the sending admin is removed", async () => {
    const { user: admin, token } = await createAdmin();
    const { user } = await createTalent();
    await sendAs(token, user.id, EMAIL);

    await testDataSource.getRepository(User).delete(admin.id);

    const rows = await emailRepo().find();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sentById).toBeNull();
  });
});
