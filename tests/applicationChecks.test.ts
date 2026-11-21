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
import { ApplicationCheck } from "../src/entities/ApplicationCheck.js";
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
  const { token: otherRecruiterToken } = await createRecruiter();
  const base = `/v1/checks/applications/${application.id}`;
  const as = (token: string | undefined, req: request.Test) =>
    token ? req.set("Authorization", `Bearer ${token}`) : req;
  const order = (token: string | undefined, type: string = "identity") =>
    as(token, request(app).post(base)).send({ type });
  const list = (token: string | undefined) => as(token, request(app).get(base));
  const agree = () =>
    request(app)
      .post(`${base}/consent`)
      .set("Authorization", `Bearer ${talentToken}`)
      .send({ version: CHECKS_CONSENT_VERSION, idKind: "nin", idNumber: "12345678901" });
  return {
    application,
    talentToken,
    posterToken,
    otherRecruiterToken,
    order,
    list,
    agree,
    base,
  };
}

describe("company orders a check only after the candidate agrees", () => {
  it("refuses an order while consent is missing and stores nothing", async () => {
    const { order, posterToken } = await setup();
    const res = await order(posterToken, "criminal");
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(await testDataSource.getRepository(ApplicationCheck).count()).toBe(0);
  });

  it("orders a pending check once the candidate has agreed", async () => {
    const { order, agree, posterToken, application } = await setup();
    await agree();
    const res = await order(posterToken, "identity");
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      id: expect.any(String),
      applicationId: application.id,
      type: "identity",
      status: "pending",
      resultText: null,
      orderedById: expect.any(String),
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it("refuses a type outside the four Day 23 checks", async () => {
    const { order, agree, posterToken } = await setup();
    await agree();
    const res = await order(posterToken, "credit");
    expect(res.status).toBe(400);
  });

  it("refuses the candidate, another recruiter and anonymous requests", async () => {
    const { order, agree, talentToken, otherRecruiterToken } = await setup();
    await agree();
    expect((await order(talentToken)).status).toBe(403);
    expect((await order(otherRecruiterToken)).status).toBe(403);
    expect((await order(undefined)).status).toBe(401);
  });

  it("answers 404 for an unknown application", async () => {
    const { posterToken } = await setup();
    const res = await request(app)
      .post("/v1/checks/applications/00000000-0000-4000-8000-000000000000")
      .set("Authorization", `Bearer ${posterToken}`)
      .send({ type: "identity" });
    expect(res.status).toBe(404);
  });
});

describe("company reads the checks with one overall status", () => {
  it("reports none with no checks ordered", async () => {
    const { list, posterToken, application } = await setup();
    const res = await list(posterToken);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      applicationId: application.id,
      overallStatus: "none",
      checks: [],
    });
  });

  it("reports pending for ordered checks and follows stored results", async () => {
    const { order, agree, list, posterToken } = await setup();
    await agree();
    await order(posterToken, "identity");
    await order(posterToken, "employment");
    expect((await list(posterToken)).body.data.overallStatus).toBe("pending");

    const repo = testDataSource.getRepository(ApplicationCheck);
    const [identity, employment] = await repo.find({ order: { createdAt: "ASC" } });
    await repo.update(identity!.id, { status: "passed", resultText: "Name matches" });
    await repo.update(employment!.id, { status: "flagged", resultText: "Gap of 8 months" });
    const flagged = await list(posterToken);
    expect(flagged.body.data.overallStatus).toBe("flagged");
    expect(flagged.body.data.checks).toEqual([
      expect.objectContaining({ type: "identity", status: "passed", resultText: "Name matches" }),
      expect.objectContaining({
        type: "employment",
        status: "flagged",
        resultText: "Gap of 8 months",
      }),
    ]);

    await repo.update(identity!.id, { status: "failed" });
    expect((await list(posterToken)).body.data.overallStatus).toBe("failed");
  });

  it("refuses another recruiter and the candidate", async () => {
    const { list, otherRecruiterToken, talentToken } = await setup();
    expect((await list(otherRecruiterToken)).status).toBe(403);
    expect((await list(talentToken)).status).toBe(403);
  });

  it("lets the company owner read a check that a fellow member ordered", async () => {
    const { user: owner, token: ownerToken } = await createRecruiter();
    const organization = await createOrganization(owner);
    const job = await createJob(owner, await createRole(), { organizationId: organization.id });
    const { user: talent, token: talentToken } = await createTalent();
    const application = await createApplication(talent, job);
    const { token: memberToken } = await createRecruiter({
      activeOrganizationId: organization.id,
    });
    const base = `/v1/checks/applications/${application.id}`;
    await request(app)
      .post(`${base}/consent`)
      .set("Authorization", `Bearer ${talentToken}`)
      .send({ version: CHECKS_CONSENT_VERSION, idKind: "nin", idNumber: "12345678901" });
    const ordered = await request(app)
      .post(base)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ type: "education" });
    expect(ordered.status).toBe(201);

    const read = await request(app).get(base).set("Authorization", `Bearer ${ownerToken}`);
    expect(read.status).toBe(200);
    expect(read.body.data.checks).toHaveLength(1);
  });
});
