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
} from "./helpers/fixtures.js";
import { ApplicationReference } from "../src/entities/ApplicationReference.js";
import { REFERENCE_QUESTIONS } from "../src/services/applicationReferenceAnswers.js";
import EmailService from "../src/utils/integrations/email/emailService.js";

const mockSendRequest = jest.fn();

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn(),
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

const ANSWERS = {
  worked_together: "We worked together for three years on the support team.",
  strengths: "Calm with customers and quick to learn.",
  improve: "Could delegate more.",
  reliability: "Always on time and never missed a deadline.",
  hire_again: "Yes, without hesitation.",
  anything_else: "A pleasure to work with.",
};

async function setup() {
  const { user: poster } = await createRecruiter();
  const role = await createRole("Support Agent");
  const job = await createJob(poster, role);
  const { user: talent, token: talentToken } = await createTalent({
    firstName: "Tobi",
    lastName: "Ade",
  });
  const application = await createApplication(talent, job);
  const added = await request(app)
    .post(`/v1/references/applications/${application.id}`)
    .set("Authorization", `Bearer ${talentToken}`)
    .send({ name: "Ada Obi", email: "ada@example.com", relationship: "Former manager" });
  expect(added.status).toBe(201);
  const token = String(mockSendRequest.mock.calls[0]![0].ctaUrl).split("/reference/")[1]!;
  const open = (t = token) => request(app).get(`/v1/references/respond/${t}`);
  const answer = (body: unknown, t = token) =>
    request(app)
      .post(`/v1/references/respond/${t}`)
      .send(body as object);
  const row = () =>
    testDataSource
      .getRepository(ApplicationReference)
      .findOneByOrFail({ applicationId: application.id });
  return { talent, token, open, answer, row, talentToken, application };
}

describe("referee opens the link", () => {
  it("shows the six questions and who is asking, with no account", async () => {
    const { open } = await setup();
    const res = await open();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      refereeName: "Ada Obi",
      candidateName: "Tobi Ade",
      jobTitle: "Support Agent",
    });
    expect(res.body.data.questions).toHaveLength(6);
    expect(res.body.data.questions.map((q: { key: string }) => q.key)).toEqual([
      "worked_together",
      "strengths",
      "improve",
      "reliability",
      "hire_again",
      "anything_else",
    ]);
    expect(res.body.data.questions[5].required).toBe(false);
    expect(REFERENCE_QUESTIONS).toHaveLength(6);
    expect(JSON.stringify(res.body)).not.toMatch(/tokenHash|ada@example/);
  });

  it("an unknown link is not found", async () => {
    await setup();
    expect((await request(app).get(`/v1/references/respond/${"a".repeat(64)}`)).status).toBe(404);
    expect((await request(app).get("/v1/references/respond/short")).status).toBe(400);
  });

  it("an expired link is refused with 410", async () => {
    const { open, application } = await setup();
    await testDataSource
      .getRepository(ApplicationReference)
      .update({ applicationId: application.id }, { tokenExpiresAt: new Date(Date.now() - 1000) });
    expect((await open()).status).toBe(410);
  });
});

describe("referee answers", () => {
  it("saves the answers and the link then stops working", async () => {
    const { answer, open, row } = await setup();
    const res = await answer({ answers: ANSWERS });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const saved = await row();
    expect(saved.answeredAt).not.toBeNull();
    expect(saved.answers).toEqual(ANSWERS);
    expect((await open()).status).toBe(410);
    const again = await answer({ answers: ANSWERS });
    expect(again.status).toBe(410);
  });

  it("the last question is optional", async () => {
    const { answer, row } = await setup();
    const { anything_else: _skipped, ...required } = ANSWERS;
    const res = await answer({ answers: required });
    expect(res.status).toBe(200);
    expect((await row()).answers).toEqual(required);
  });

  it("refuses answers with a required question empty or missing", async () => {
    const { answer, row } = await setup();
    expect((await answer({ answers: { ...ANSWERS, strengths: "  " } })).status).toBe(400);
    const { reliability: _missing, ...partial } = ANSWERS;
    expect((await answer({ answers: partial })).status).toBe(400);
    expect((await answer({})).status).toBe(400);
    const saved = await row();
    expect(saved.answeredAt).toBeNull();
    expect(saved.answers).toBeNull();
  });

  it("ignores unknown keys and caps a long answer", async () => {
    const { answer, row } = await setup();
    const tooLong = await answer({ answers: { ...ANSWERS, strengths: "x".repeat(2001) } });
    expect(tooLong.status).toBe(400);
    const ok = await answer({ answers: { ...ANSWERS, extra: "ignored" } });
    expect(ok.status).toBe(200);
    expect((await row()).answers).toEqual(ANSWERS);
  });

  it("an expired link cannot be used to answer", async () => {
    const { answer, application, row } = await setup();
    await testDataSource
      .getRepository(ApplicationReference)
      .update({ applicationId: application.id }, { tokenExpiresAt: new Date(Date.now() - 1000) });
    expect((await answer({ answers: ANSWERS })).status).toBe(410);
    expect((await row()).answeredAt).toBeNull();
  });

  it("two answers sent at once are accepted once", async () => {
    const { answer, row } = await setup();
    const results = await Promise.all([answer({ answers: ANSWERS }), answer({ answers: ANSWERS })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
    expect((await row()).answeredAt).not.toBeNull();
  });

  it("the candidate's list shows the referee as answered, never the answers", async () => {
    const { answer, talentToken, application } = await setup();
    await answer({ answers: ANSWERS });
    const res = await request(app)
      .get(`/v1/references/applications/${application.id}`)
      .set("Authorization", `Bearer ${talentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.references[0].status).toBe("answered");
    expect(JSON.stringify(res.body)).not.toContain("three years");
  });

  it("stores only a hash of the link", async () => {
    const { token, row } = await setup();
    expect((await row()).tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
  });
});
