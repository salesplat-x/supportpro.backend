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
} from "./helpers/fixtures.js";
import { ApplicationReference } from "../src/entities/ApplicationReference.js";
import { User } from "../src/entities/User.js";
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
  worked_together: "Three years on the support team.",
  strengths: "Calm with customers.",
  improve: "Could delegate more.",
  reliability: "Always on time.",
  hire_again: "Yes",
};

async function setup() {
  const { user: poster, token: posterToken } = await createRecruiter();
  const organization = await createOrganization(poster);
  const job = await createJob(poster, await createRole(), { organizationId: organization.id });
  const { user: teammate, token: teammateToken } = await createRecruiter();
  await testDataSource
    .getRepository(User)
    .update(teammate.id, { activeOrganizationId: organization.id });
  const { user: talent, token: talentToken } = await createTalent();
  const application = await createApplication(talent, job);
  const add = (email: string, name = "Ada Obi") =>
    request(app)
      .post(`/v1/references/applications/${application.id}`)
      .set("Authorization", `Bearer ${talentToken}`)
      .send({ referees: [{ name, email, relationship: "manager" }] });
  const added = await add("ada@example.com");
  const referenceId = added.body.data.references[0].id as string;
  const tokenOf = (call = 0) =>
    String(mockSendRequest.mock.calls[call]![0].ctaUrl).split("/reference/")[1]!;
  const answer = (token: string) =>
    request(app).post(`/v1/references/respond/${token}`).send({ answers: ANSWERS });
  const read = (token: string) =>
    request(app)
      .get(`/v1/references/applications/${application.id}/answers`)
      .set("Authorization", `Bearer ${token}`);
  const resend = (token: string, id = referenceId) =>
    request(app).post(`/v1/references/${id}/resend`).set("Authorization", `Bearer ${token}`);
  return {
    poster,
    posterToken,
    teammateToken,
    talentToken,
    application,
    referenceId,
    add,
    tokenOf,
    answer,
    read,
    resend,
  };
}

describe("company reads the references", () => {
  it("the posting company sees who was asked, who answered and the answers", async () => {
    const { read, posterToken, answer, tokenOf, add } = await setup();
    await add("bola@example.com", "Bola Ade");
    await answer(tokenOf(0));
    const res = await read(posterToken);
    expect(res.status).toBe(200);
    const refs = res.body.data.references as Array<Record<string, unknown>>;
    expect(refs).toHaveLength(2);
    const ada = refs.find((r) => r["name"] === "Ada Obi")!;
    expect(ada["status"]).toBe("answered");
    expect(ada["answers"]).toEqual([
      { key: "worked_together", question: expect.any(String), answer: ANSWERS.worked_together },
      { key: "strengths", question: expect.any(String), answer: ANSWERS.strengths },
      { key: "improve", question: expect.any(String), answer: ANSWERS.improve },
      { key: "reliability", question: expect.any(String), answer: ANSWERS.reliability },
      { key: "hire_again", question: expect.any(String), answer: ANSWERS.hire_again },
    ]);
    const bola = refs.find((r) => r["name"] === "Bola Ade")!;
    expect(bola["status"]).toBe("sent");
    expect(bola["answers"]).toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(/tokenHash/);
  });

  it("a teammate in the posting company reads them too", async () => {
    const { read, teammateToken } = await setup();
    expect((await read(teammateToken)).status).toBe(200);
  });

  it("the candidate, another candidate and a recruiter outside the company are refused", async () => {
    const { read, talentToken } = await setup();
    expect((await read(talentToken)).status).toBe(403);
    const { token: otherTalent } = await createTalent();
    expect((await read(otherTalent)).status).toBe(403);
    const { token: stranger } = await createRecruiter();
    expect((await read(stranger)).status).toBe(403);
  });

  it("anonymous requests are refused and unknown applications are not found", async () => {
    const { application, posterToken } = await setup();
    const anonymous = await request(app).get(
      `/v1/references/applications/${application.id}/answers`
    );
    expect(anonymous.status).toBe(401);
    const missing = await request(app)
      .get("/v1/references/applications/00000000-0000-4000-8000-000000000000/answers")
      .set("Authorization", `Bearer ${posterToken}`);
    expect(missing.status).toBe(404);
  });
});

describe("resending a reference request", () => {
  it("sends a new link, retires the old one and restarts the 14 days", async () => {
    const { resend, posterToken, referenceId, tokenOf, answer } = await setup();
    const oldToken = tokenOf(0);
    await testDataSource
      .getRepository(ApplicationReference)
      .update(referenceId, { tokenExpiresAt: new Date(Date.now() - 1000) });
    const res = await resend(posterToken);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("sent");
    const days = (new Date(res.body.data.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(mockSendRequest).toHaveBeenCalledTimes(2);
    const newToken = tokenOf(1);
    expect(newToken).not.toBe(oldToken);
    expect((await answer(oldToken)).status).toBe(404);
    expect((await answer(newToken)).status).toBe(200);
  });

  it("a teammate can resend, the candidate and outsiders cannot", async () => {
    const { resend, teammateToken, talentToken } = await setup();
    expect((await resend(talentToken)).status).toBe(403);
    const { token: stranger } = await createRecruiter();
    expect((await resend(stranger)).status).toBe(403);
    expect((await resend(teammateToken)).status).toBe(200);
  });

  it("refuses to resend to a referee who already answered", async () => {
    const { resend, posterToken, answer, tokenOf } = await setup();
    await answer(tokenOf(0));
    expect((await resend(posterToken)).status).toBe(409);
    expect(mockSendRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps the new link unsent when the email fails, and an unknown referee is not found", async () => {
    const { resend, posterToken } = await setup();
    mockSendRequest.mockRejectedValueOnce(new Error("provider down"));
    const res = await resend(posterToken);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("not_sent");
    const missing = await resend(posterToken, "00000000-0000-4000-8000-000000000000");
    expect(missing.status).toBe(404);
  });
});
