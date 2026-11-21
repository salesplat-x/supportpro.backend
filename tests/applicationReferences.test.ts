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

const REFEREE = { name: "Ada Obi", email: "Ada.Obi@Example.com", relationship: "manager" };

async function setup() {
  const { user: poster } = await createRecruiter();
  const job = await createJob(poster, await createRole());
  const { user: talent, token: talentToken } = await createTalent();
  const application = await createApplication(talent, job);
  const addMany = (
    token: string,
    referees: Array<Record<string, unknown>> = [REFEREE],
    applicationId = application.id
  ) =>
    request(app)
      .post(`/v1/references/applications/${applicationId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ referees });
  const add = (
    token: string,
    body: Record<string, unknown> = REFEREE,
    applicationId = application.id
  ) => addMany(token, [body], applicationId);
  const list = (token: string) =>
    request(app)
      .get(`/v1/references/applications/${application.id}`)
      .set("Authorization", `Bearer ${token}`);
  return { poster, job, talent, talentToken, application, add, addMany, list };
}

describe("candidate names a referee", () => {
  it("saves the referee and emails a one-time link that expires in 14 days", async () => {
    const { add, talentToken, application, job, talent } = await setup();
    const res = await add(talentToken);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.references).toHaveLength(1);
    expect(res.body.data.references[0]).toMatchObject({
      name: "Ada Obi",
      email: "ada.obi@example.com",
      relationship: "manager",
      status: "sent",
    });
    expect(JSON.stringify(res.body)).not.toMatch(/token/i);
    const expiresInDays =
      (new Date(res.body.data.references[0].expiresAt).getTime() - Date.now()) /
      (24 * 60 * 60 * 1000);
    expect(expiresInDays).toBeGreaterThan(13.9);
    expect(expiresInDays).toBeLessThanOrEqual(14);

    expect(mockSendRequest).toHaveBeenCalledTimes(1);
    const mail = mockSendRequest.mock.calls[0]![0];
    expect(mail).toMatchObject({
      to: "ada.obi@example.com",
      refereeName: "Ada Obi",
      candidateName: `${talent.firstName} ${talent.lastName}`,
    });
    const token = String(mail.ctaUrl).split("/reference/")[1];
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const stored = await testDataSource.getRepository(ApplicationReference).findOneByOrFail({
      applicationId: application.id,
    });
    expect(stored.jobId).toBe(job.id);
    expect(stored.talentId).toBe(talent.id);
    expect(stored.tokenHash).toBe(createHash("sha256").update(token!).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(token!);
    expect(stored.sentAt).not.toBeNull();
    expect(stored.answeredAt).toBeNull();
  });

  it("sends up to 3 referees in one request and emails each", async () => {
    const { addMany, talentToken } = await setup();
    const ok = await addMany(
      talentToken,
      [1, 2, 3].map((n) => ({
        name: `Ref ${n}`,
        email: `ref${n}@example.com`,
        relationship: "colleague",
      }))
    );
    expect(ok.status).toBe(201);
    expect(ok.body.data.references).toHaveLength(3);
    expect(mockSendRequest).toHaveBeenCalledTimes(3);
  });

  it("refuses more than 3 referees in total and saves none of them", async () => {
    const { add, addMany, talentToken } = await setup();
    expect((await add(talentToken)).status).toBe(201);
    const tooMany = await addMany(
      talentToken,
      [1, 2, 3].map((n) => ({
        name: `Ref ${n}`,
        email: `ref${n}@example.com`,
        relationship: "colleague",
      }))
    );
    expect(tooMany.status).toBe(400);
    expect(await testDataSource.getRepository(ApplicationReference).count()).toBe(1);
    const four = await addMany(
      talentToken,
      [1, 2, 3, 4].map((n) => ({
        name: `Ref ${n}`,
        email: `four${n}@example.com`,
        relationship: "client",
      }))
    );
    expect(four.status).toBe(400);
  });

  it("refuses the same email twice inside one request", async () => {
    const { addMany, talentToken } = await setup();
    const res = await addMany(talentToken, [REFEREE, { ...REFEREE, name: "Someone Else" }]);
    expect(res.status).toBe(409);
    expect(await testDataSource.getRepository(ApplicationReference).count()).toBe(0);
  });

  it("refuses the same email twice for one application", async () => {
    const { add, talentToken } = await setup();
    expect((await add(talentToken)).status).toBe(201);
    const again = await add(talentToken, { ...REFEREE, name: "Someone Else" });
    expect(again.status).toBe(409);
    expect(await testDataSource.getRepository(ApplicationReference).count()).toBe(1);
  });

  it("rejects a missing name, a bad email and a relationship outside the list", async () => {
    const { add, addMany, talentToken } = await setup();
    expect((await add(talentToken, { ...REFEREE, name: "" })).status).toBe(400);
    expect((await add(talentToken, { ...REFEREE, email: "not-an-email" })).status).toBe(400);
    expect((await add(talentToken, { ...REFEREE, relationship: "" })).status).toBe(400);
    expect((await add(talentToken, { ...REFEREE, relationship: "Former manager" })).status).toBe(
      400
    );
    expect((await addMany(talentToken, [])).status).toBe(400);
    expect(mockSendRequest).not.toHaveBeenCalled();
  });

  it("keeps the referee, unsent, when the email provider fails", async () => {
    mockSendRequest.mockRejectedValueOnce(new Error("provider down"));
    const { add, talentToken, application } = await setup();
    const res = await add(talentToken);
    expect(res.status).toBe(201);
    expect(res.body.data.references[0].status).toBe("not_sent");
    const stored = await testDataSource
      .getRepository(ApplicationReference)
      .findOneByOrFail({ applicationId: application.id });
    expect(stored.sentAt).toBeNull();
  });

  it("only the candidate who applied can add referees", async () => {
    const { add } = await setup();
    const { token: otherTalent } = await createTalent();
    expect((await add(otherTalent)).status).toBe(403);
    const { token: recruiterToken } = await createRecruiter();
    expect((await add(recruiterToken)).status).toBe(403);
    const anonymous = await request(app)
      .post("/v1/references/applications/00000000-0000-4000-8000-000000000000")
      .send({ referees: [REFEREE] });
    expect(anonymous.status).toBe(401);
  });

  it("an unknown application is not found", async () => {
    const { add, talentToken } = await setup();
    const res = await add(talentToken, REFEREE, "00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
  });
});

describe("candidate sees who was asked", () => {
  it("lists the referees without links or answers", async () => {
    const { add, list, talentToken } = await setup();
    await add(talentToken);
    const res = await list(talentToken);
    expect(res.status).toBe(200);
    expect(res.body.data.references).toHaveLength(1);
    expect(res.body.data.references[0]).toMatchObject({
      name: "Ada Obi",
      email: "ada.obi@example.com",
      relationship: "manager",
      status: "sent",
    });
    expect(JSON.stringify(res.body)).not.toMatch(/token|answers/i);
  });

  it("another candidate cannot list them", async () => {
    const { list } = await setup();
    const { token: otherTalent } = await createTalent();
    expect((await list(otherTalent)).status).toBe(403);
  });
});
