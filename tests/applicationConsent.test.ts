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
} from "./helpers/fixtures.js";
import { ApplicationConsent } from "../src/entities/ApplicationConsent.js";
import { CHECKS_CONSENT_VERSION } from "../src/services/checkConsent.js";

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
  jest.clearAllMocks();
});

async function setup() {
  const { user: poster, token: posterToken } = await createRecruiter();
  const job = await createJob(poster, await createRole());
  const { user: talent, token: talentToken } = await createTalent();
  const application = await createApplication(talent, job);
  const { token: otherToken } = await createRecruiter();
  const { token: otherCandidateToken } = await createTalent();
  const agree = (
    token?: string,
    body: Record<string, unknown> = { version: CHECKS_CONSENT_VERSION }
  ) => {
    const req = request(app).post(`/v1/checks/applications/${application.id}/consent`);
    return token ? req.set("Authorization", `Bearer ${token}`).send(body) : req.send(body);
  };
  const read = (token: string) =>
    request(app)
      .get(`/v1/checks/applications/${application.id}/consent`)
      .set("Authorization", `Bearer ${token}`);
  return {
    application,
    talent,
    talentToken,
    posterToken,
    otherToken,
    otherCandidateToken,
    agree,
    read,
  };
}

describe("candidate agrees to background checks", () => {
  it("stores the agreement with its time and the consent text version", async () => {
    const { agree, talentToken, application, talent } = await setup();
    const res = await agree(talentToken);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      success: true,
      data: {
        applicationId: application.id,
        version: CHECKS_CONSENT_VERSION,
        agreedAt: expect.any(String),
      },
    });

    const stored = await testDataSource
      .getRepository(ApplicationConsent)
      .findOneByOrFail({ applicationId: application.id });
    expect(stored.talentId).toBe(talent.id);
    expect(stored.version).toBe(CHECKS_CONSENT_VERSION);
    expect(stored.agreedAt).toBeInstanceOf(Date);
  });

  it("keeps one agreement per application and returns the first one again", async () => {
    const { agree, talentToken, application } = await setup();
    const first = await agree(talentToken);
    const again = await agree(talentToken);
    expect(again.status).toBe(200);
    expect(again.body.data.agreedAt).toBe(first.body.data.agreedAt);
    const rows = await testDataSource
      .getRepository(ApplicationConsent)
      .countBy({ applicationId: application.id });
    expect(rows).toBe(1);
  });

  it("refuses a consent text version that is not the current one", async () => {
    const { agree, talentToken } = await setup();
    const res = await agree(talentToken, { version: "1999-01-v0" });
    expect(res.status).toBe(400);
  });

  it("refuses a recruiter and another candidate", async () => {
    const { agree, posterToken, otherCandidateToken } = await setup();
    expect((await agree(posterToken)).status).toBe(403);
    expect((await agree(otherCandidateToken)).status).toBe(403);
  });

  it("refuses an anonymous request and an unknown application", async () => {
    const { agree, talentToken } = await setup();
    expect((await agree()).status).toBe(401);
    const unknown = await request(app)
      .post(`/v1/checks/applications/00000000-0000-4000-8000-000000000000/consent`)
      .set("Authorization", `Bearer ${talentToken}`)
      .send({ version: CHECKS_CONSENT_VERSION });
    expect(unknown.status).toBe(404);
  });
});

describe("the posting company reads whether consent was given", () => {
  it("shows no consent before the candidate agrees", async () => {
    const { read, posterToken } = await setup();
    const res = await read(posterToken);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      applicationId: expect.any(String),
      consented: false,
      version: null,
      agreedAt: null,
    });
  });

  it("shows the agreement once the candidate has given it", async () => {
    const { read, agree, talentToken, posterToken } = await setup();
    await agree(talentToken);
    const res = await read(posterToken);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      consented: true,
      version: CHECKS_CONSENT_VERSION,
      agreedAt: expect.any(String),
    });
  });

  it("refuses a recruiter from another company and the candidate", async () => {
    const { read, otherToken, talentToken } = await setup();
    expect((await read(otherToken)).status).toBe(403);
    expect((await read(talentToken)).status).toBe(403);
  });
});
