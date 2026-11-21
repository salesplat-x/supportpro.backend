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
import EmailService from "../src/utils/integrations/email/emailService.js";
import { ApplicationConsent } from "../src/entities/ApplicationConsent.js";
import { CHECKS_CONSENT_VERSION } from "../src/services/checkConsent.js";
import { decryptSecret } from "../src/utils/secretBox.js";

const mockSendConsentRequest = jest.fn();

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
    sendChecksConsentRequest: mockSendConsentRequest,
    sendApplicantMessage: jest.fn().mockResolvedValue(undefined),
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  }));
  mockSendConsentRequest.mockResolvedValue(undefined);
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
    body: Record<string, unknown> = {
      version: CHECKS_CONSENT_VERSION,
      idKind: "nin",
      idNumber: "12345678901",
    }
  ) => {
    const req = request(app).post(`/v1/checks/applications/${application.id}/consent`);
    return token ? req.set("Authorization", `Bearer ${token}`).send(body) : req.send(body);
  };
  const read = (token: string) =>
    request(app)
      .get(`/v1/checks/applications/${application.id}/consent`)
      .set("Authorization", `Bearer ${token}`);
  const mine = (token: string) =>
    request(app)
      .get(`/v1/checks/applications/${application.id}/consent/mine`)
      .set("Authorization", `Bearer ${token}`);
  const decline = (token: string) =>
    request(app)
      .post(`/v1/checks/applications/${application.id}/consent/decline`)
      .set("Authorization", `Bearer ${token}`);
  const ask = (token: string) =>
    request(app)
      .post(`/v1/checks/applications/${application.id}/consent/request`)
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
    mine,
    decline,
    ask,
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
        state: "agreed",
        version: CHECKS_CONSENT_VERSION,
        requestedAt: expect.any(String),
        agreedAt: expect.any(String),
        declinedAt: null,
        idKind: "nin",
        idNumberLast4: "8901",
      },
    });
    expect(JSON.stringify(res.body)).not.toContain("12345678901");

    const stored = await testDataSource
      .getRepository(ApplicationConsent)
      .findOneByOrFail({ applicationId: application.id });
    expect(stored.talentId).toBe(talent.id);
    expect(stored.version).toBe(CHECKS_CONSENT_VERSION);
    expect(stored.agreedAt).toBeInstanceOf(Date);
    expect(stored.idNumberLast4).toBe("8901");
    expect(stored.idNumberEncrypted).not.toContain("12345678901");
    expect(decryptSecret(stored.idNumberEncrypted!)).toBe("12345678901");
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
    const res = await agree(talentToken, {
      version: "1999-01-v0",
      idKind: "nin",
      idNumber: "12345678901",
    });
    expect(res.status).toBe(400);
  });

  it("refuses an ID number that is not exactly 11 digits or a kind other than nin or bvn", async () => {
    const { agree, talentToken, application } = await setup();
    for (const body of [
      { idKind: "nin", idNumber: "1234567890" },
      { idKind: "nin", idNumber: "123456789012" },
      { idKind: "bvn", idNumber: "1234567890a" },
      { idKind: "passport", idNumber: "12345678901" },
      { idKind: "nin" },
    ]) {
      expect((await agree(talentToken, { version: CHECKS_CONSENT_VERSION, ...body })).status).toBe(
        400
      );
    }
    expect(
      await testDataSource.getRepository(ApplicationConsent).countBy({
        applicationId: application.id,
      })
    ).toBe(0);
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
      .send({ version: CHECKS_CONSENT_VERSION, idKind: "nin", idNumber: "12345678901" });
    expect(unknown.status).toBe(404);
  });
});

describe("the posting company reads whether consent was given", () => {
  it("shows no consent before the candidate agrees", async () => {
    const { read, posterToken } = await setup();
    const res = await read(posterToken);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      state: "not_requested",
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
      state: "agreed",
      version: CHECKS_CONSENT_VERSION,
      agreedAt: expect.any(String),
      idNumberLast4: "8901",
    });
    expect(JSON.stringify(res.body)).not.toContain("12345678901");
  });

  it("refuses a recruiter from another company and the candidate", async () => {
    const { read, otherToken, talentToken } = await setup();
    expect((await read(otherToken)).status).toBe(403);
    expect((await read(talentToken)).status).toBe(403);
  });
});

describe("candidate declines, and the company asks", () => {
  it("records a decline, which the company sees, and the candidate can still agree later", async () => {
    const { decline, agree, read, mine, talentToken, posterToken } = await setup();
    const res = await decline(talentToken);
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe("declined");
    expect((await read(posterToken)).body.data.state).toBe("declined");
    expect((await mine(talentToken)).body.data.state).toBe("declined");
    const agreed = await agree(talentToken);
    expect(agreed.status).toBe(201);
    expect(agreed.body.data).toMatchObject({ state: "agreed", declinedAt: null });
  });

  it("refuses to decline after agreeing, and refuses others", async () => {
    const { decline, agree, talentToken, posterToken, otherCandidateToken } = await setup();
    await agree(talentToken);
    expect((await decline(talentToken)).status).toBe(409);
    expect((await decline(posterToken)).status).toBe(403);
    expect((await decline(otherCandidateToken)).status).toBe(403);
  });

  it("lets only the candidate read their own consent", async () => {
    const { mine, talentToken, posterToken } = await setup();
    const res = await mine(talentToken);
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe("not_requested");
    expect((await mine(posterToken)).status).toBe(403);
  });

  it("lets the posting company ask once, emails the candidate, and shows requested", async () => {
    const { ask, read, posterToken, otherToken, talentToken } = await setup();
    const first = await ask(posterToken);
    expect(first.status).toBe(201);
    expect(first.body.data.state).toBe("requested");
    expect(mockSendConsentRequest).toHaveBeenCalledTimes(1);
    expect(mockSendConsentRequest.mock.calls[0]![0].ctaUrl).toMatch(
      /\/talentDashboard\/applications\/.+\/checks$/
    );
    const again = await ask(posterToken);
    expect(again.status).toBe(200);
    expect(mockSendConsentRequest).toHaveBeenCalledTimes(1);
    expect((await read(posterToken)).body.data.state).toBe("requested");
    expect((await ask(otherToken)).status).toBe(403);
    expect((await ask(talentToken)).status).toBe(403);
  });

  it("keeps the request when the email fails", async () => {
    mockSendConsentRequest.mockRejectedValueOnce(new Error("provider down"));
    const { ask, read, posterToken } = await setup();
    expect((await ask(posterToken)).status).toBe(201);
    expect((await read(posterToken)).body.data.state).toBe("requested");
  });
});

describe("shortlisting asks the candidate for consent", () => {
  it("creates one request and one email, however many times the status is set", async () => {
    const { application, posterToken, read } = await setup();
    const shortlist = () =>
      request(app)
        .patch(`/v1/applications/${application.id}/status`)
        .set("Authorization", `Bearer ${posterToken}`)
        .send({ status: "shortlisted" });
    expect((await shortlist()).status).toBe(200);
    expect((await shortlist()).status).toBe(200);
    expect(mockSendConsentRequest).toHaveBeenCalledTimes(1);
    expect((await read(posterToken)).body.data.state).toBe("requested");
  });

  it("does not ask when the candidate is rejected", async () => {
    const { application, posterToken, read } = await setup();
    await request(app)
      .patch(`/v1/applications/${application.id}/status`)
      .set("Authorization", `Bearer ${posterToken}`)
      .send({ status: "rejected" });
    expect(mockSendConsentRequest).not.toHaveBeenCalled();
    expect((await read(posterToken)).body.data.state).toBe("not_requested");
  });
});
