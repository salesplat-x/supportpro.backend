import request from "supertest";
import { createHash } from "crypto";
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
} from "./helpers/fixtures.js";
import { SIX_QUESTIONS, sendCompanyQuestions, setCompanyQuestions } from "./helpers/references.js";
import { ApplicationReference } from "../src/entities/ApplicationReference.js";
import { User } from "../src/entities/User.js";
import EmailService from "../src/utils/integrations/email/emailService.js";
import { generateReferenceQuestions } from "../src/utils/integrations/openai.js";
import { parseGeneratedQuestions } from "../src/services/referenceQuestions.js";

const mockSendRequest = jest.fn();

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
  generateReferenceQuestions: jest.fn(),
}));

const mockGenerate = generateReferenceQuestions as jest.Mock;

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
    sendReferenceRequest: mockSendRequest,
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  }));
  mockSendRequest.mockResolvedValue(undefined);
});

afterEach(async () => {
  await clearAllTables();
  jest.clearAllMocks();
});

async function setup() {
  const { user: owner, token: ownerToken } = await createRecruiter();
  const organization = await createOrganization(owner);
  const { user: teammate, token: teammateToken } = await createRecruiter();
  await testDataSource
    .getRepository(User)
    .update(teammate.id, { activeOrganizationId: organization.id });
  const job = await createJob(owner, await createRole("Support Agent"), {
    organizationId: organization.id,
  });
  const base = `/v1/organizations/${organization.id}/reference-questions`;
  const get = (token: string) => request(app).get(base).set("Authorization", `Bearer ${token}`);
  const save = (token: string, questions: unknown) =>
    request(app).put(base).set("Authorization", `Bearer ${token}`).send({ questions });
  const generate = (token: string, count: unknown) =>
    request(app).post(`${base}/generate`).set("Authorization", `Bearer ${token}`).send({ count });
  const jobs = (token: string) =>
    request(app).get(`${base}/jobs`).set("Authorization", `Bearer ${token}`);
  const send = (token: string, jobIds: string[]) =>
    sendCompanyQuestions(app, token, organization.id, jobIds);
  const addReferees = async (forJob = job, count = 1) => {
    const { user: talent, token: talentToken } = await createTalent();
    const application = await createApplication(talent, forJob);
    const res = await request(app)
      .post(`/v1/references/applications/${application.id}`)
      .set("Authorization", `Bearer ${talentToken}`)
      .send({
        referees: Array.from({ length: count }, (_, n) => ({
          name: `Ref ${n}`,
          email: `ref${n}-${application.id}@example.com`,
          relationship: "colleague",
        })),
      });
    expect(res.status).toBe(201);
    return application;
  };
  return {
    owner,
    ownerToken,
    teammateToken,
    organization,
    job,
    get,
    save,
    generate,
    jobs,
    send,
    addReferees,
  };
}

const QUESTION = { question: "Did they meet deadlines?", type: "yesno", required: true };

describe("company reference questions", () => {
  it("starts empty, and any member can save written and Yes/No questions", async () => {
    const { get, save, ownerToken, teammateToken } = await setup();
    expect((await get(ownerToken)).body.data.questions).toEqual([]);

    const saved = await save(teammateToken, [
      QUESTION,
      { question: "  Describe their best work.  ", type: "text", required: false },
      { question: "   ", type: "text", required: true },
    ]);
    expect(saved.status).toBe(200);
    const questions = saved.body.data.questions as Array<Record<string, unknown>>;
    expect(questions).toHaveLength(2);
    expect(questions[0]).toMatchObject(QUESTION);
    expect(questions[1]).toMatchObject({
      question: "Describe their best work.",
      type: "text",
      required: false,
    });
    expect(questions[0]!["key"]).toMatch(/^[0-9a-f-]{36}$/);

    const reread = await get(ownerToken);
    expect(reread.body.data.questions).toEqual(questions);
  });

  it("keeps a question's key when it is saved again", async () => {
    const { save, ownerToken } = await setup();
    const first = await save(ownerToken, [QUESTION]);
    const key = first.body.data.questions[0].key;
    const second = await save(ownerToken, [{ ...QUESTION, key, question: "Were they on time?" }]);
    expect(second.body.data.questions[0]).toMatchObject({ key, question: "Were they on time?" });
  });

  it("rejects a bad type, a long question, a missing flag and more than 15 questions", async () => {
    const { save, ownerToken } = await setup();
    expect((await save(ownerToken, [{ ...QUESTION, type: "scale" }])).status).toBe(400);
    expect((await save(ownerToken, [{ ...QUESTION, question: "x".repeat(301) }])).status).toBe(400);
    expect((await save(ownerToken, [{ question: "Hi?", type: "text" }])).status).toBe(400);
    expect(
      (
        await save(
          ownerToken,
          Array.from({ length: 16 }, () => QUESTION)
        )
      ).status
    ).toBe(400);
    expect((await save(ownerToken, "nope")).status).toBe(400);
  });

  it("refuses people outside the company", async () => {
    const { get, save, generate, jobs, send, job } = await setup();
    const { token: stranger } = await createRecruiter();
    expect((await get(stranger)).status).toBe(403);
    expect((await save(stranger, [QUESTION])).status).toBe(403);
    expect((await generate(stranger, 3)).status).toBe(403);
    expect((await jobs(stranger)).status).toBe(403);
    expect((await send(stranger, [job.id])).status).toBe(403);
    const { token: talentToken } = await createTalent();
    expect((await get(talentToken)).status).toBe(403);
  });
});

describe("AI writes reference questions", () => {
  it("returns the asked number of drafts without saving them", async () => {
    const { generate, get, ownerToken } = await setup();
    mockGenerate.mockResolvedValue({
      message: {
        content: JSON.stringify({
          questions: [
            { question: "How did you work together?", type: "text" },
            { question: "Would you hire them again?", type: "yesno" },
            { question: "What are their strengths?", type: "text" },
          ],
        }),
      },
    });
    const res = await generate(ownerToken, 3);
    expect(res.status).toBe(200);
    expect(mockGenerate).toHaveBeenCalledWith(3);
    expect(res.body.data.questions).toEqual([
      { question: "How did you work together?", type: "text", required: true },
      { question: "Would you hire them again?", type: "yesno", required: true },
      { question: "What are their strengths?", type: "text", required: true },
    ]);
    expect((await get(ownerToken)).body.data.questions).toEqual([]);
  });

  it("asks for 1 to 10 and reports a failed reply", async () => {
    const { generate, ownerToken } = await setup();
    expect((await generate(ownerToken, 0)).status).toBe(400);
    expect((await generate(ownerToken, 11)).status).toBe(400);
    mockGenerate.mockResolvedValue({ message: { content: "not json" } });
    const res = await generate(ownerToken, 2);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("REFERENCE_QUESTIONS_FAILED");
  });

  it("drops blank or overlong drafts and treats unknown types as written", () => {
    const parsed = parseGeneratedQuestions(
      JSON.stringify({
        questions: [
          { question: "  ", type: "text" },
          { question: "x".repeat(301), type: "text" },
          { question: "Were they reliable?", type: "rating" },
          { question: "Again?", type: "yesno" },
          "loose string",
        ],
      }),
      5
    );
    expect(parsed).toEqual([
      { question: "Were they reliable?", type: "text", required: true },
      { question: "Again?", type: "yesno", required: true },
    ]);
    expect(parseGeneratedQuestions(JSON.stringify({ questions: [] }), 3)).toBeNull();
  });
});

describe("sending questions to the referees of chosen jobs", () => {
  it("lists only jobs with referees still waiting, with how many", async () => {
    const { jobs, ownerToken, addReferees, job, owner, organization, send } = await setup();
    const quiet = await createJob(owner, await createRole("Sales Lead"), {
      organizationId: organization.id,
    });
    const busy = await createJob(owner, await createRole("Ops Lead"), {
      organizationId: organization.id,
    });
    await addReferees(job, 2);
    await addReferees(busy, 3);
    await addReferees(busy, 1);
    const res = await jobs(ownerToken);
    expect(res.status).toBe(200);
    const rows = res.body.data.jobs as Array<{ jobId: string; title: string; waiting: number }>;
    expect(rows.map((row) => [row.title, row.waiting]).sort()).toEqual([
      ["Ops Lead", 4],
      ["Support Agent", 2],
    ]);
    expect(rows.some((row) => row.jobId === quiet.id)).toBe(false);

    await setCompanyQuestions(organization.id);
    await send(ownerToken, [busy.id]);
    const after = await jobs(ownerToken);
    expect(after.body.data.jobs).toHaveLength(1);
    expect(after.body.data.jobs[0]).toMatchObject({ jobId: job.id, waiting: 2 });
  });

  it("refuses to send before the company has any questions", async () => {
    const { send, ownerToken, job, addReferees } = await setup();
    await addReferees();
    const res = await send(ownerToken, [job.id]);
    expect(res.status).toBe(400);
    expect(mockSendRequest).not.toHaveBeenCalled();
  });

  it("emails every waiting referee of the chosen jobs once, with a copy of the questions", async () => {
    const { send, teammateToken, job, addReferees, organization, owner } = await setup();
    const other = await createJob(owner, await createRole(), { organizationId: organization.id });
    const application = await addReferees(job, 2);
    await addReferees(other, 1);
    await setCompanyQuestions(organization.id);

    const res = await send(teammateToken, [job.id]);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sent: 2, failed: 0 });
    expect(mockSendRequest).toHaveBeenCalledTimes(2);

    const rows = await testDataSource
      .getRepository(ApplicationReference)
      .findBy({ applicationId: application.id });
    for (const row of rows) {
      expect(row.sentAt).not.toBeNull();
      expect(row.questions).toEqual(SIX_QUESTIONS);
      const days = (row.tokenExpiresAt.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(13.9);
    }
    const tokens = mockSendRequest.mock.calls.map(
      (call) => String(call[0].ctaUrl).split("/reference/")[1]!
    );
    expect(rows.map((row) => row.tokenHash).sort()).toEqual(
      tokens.map((token) => createHash("sha256").update(token).digest("hex")).sort()
    );

    const again = await send(teammateToken, [job.id]);
    expect(again.body.data).toEqual({ sent: 0, failed: 0 });
    expect(mockSendRequest).toHaveBeenCalledTimes(2);
  });

  it("keeps a referee waiting when the email fails, so it can be sent again", async () => {
    const { send, ownerToken, job, addReferees, organization } = await setup();
    const application = await addReferees();
    await setCompanyQuestions(organization.id);
    mockSendRequest.mockRejectedValueOnce(new Error("provider down"));
    expect((await send(ownerToken, [job.id])).body.data).toEqual({ sent: 0, failed: 1 });
    const row = await testDataSource
      .getRepository(ApplicationReference)
      .findOneByOrFail({ applicationId: application.id });
    expect(row.sentAt).toBeNull();
    expect(row.questions).toBeNull();
    expect((await send(ownerToken, [job.id])).body.data).toEqual({ sent: 1, failed: 0 });
  });

  it("two sends at once email each referee once", async () => {
    const { send, ownerToken, job, addReferees, organization } = await setup();
    await addReferees(job, 3);
    await setCompanyQuestions(organization.id);
    const results = await Promise.all([send(ownerToken, [job.id]), send(ownerToken, [job.id])]);
    const total = results.reduce((sum, res) => sum + res.body.data.sent, 0);
    expect(total).toBe(3);
    expect(mockSendRequest).toHaveBeenCalledTimes(3);
  });

  it("refuses a job from another company and bad job ids", async () => {
    const { send, ownerToken, organization } = await setup();
    await setCompanyQuestions(organization.id);
    const { user: rival } = await createRecruiter();
    const rivalOrg = await createOrganization(rival);
    const rivalJob = await createJob(rival, await createRole(), { organizationId: rivalOrg.id });
    expect((await send(ownerToken, [rivalJob.id])).status).toBe(403);
    expect((await send(ownerToken, [])).status).toBe(400);
    expect((await send(ownerToken, ["not-a-uuid"])).status).toBe(400);
  });
});
