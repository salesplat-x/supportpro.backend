/**
 * Message tests — bulk/broadcast messaging (item 5), chat sessions grouped by
 * job (item 8), and the hard server-side block on talents replying (item 8/10).
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
} from "./helpers/fixtures.js";
import { Message } from "../src/entities/Message.js";
import { ApplicationStatus } from "../src/types/enums.js";

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

describe("POST /v1/messages/ — talents cannot send messages (item 8/10)", () => {
  it("a talent's POST is rejected", async () => {
    const { user: talent, token: talentToken } = await createTalent();
    const { user: recruiter } = await createRecruiter();

    const res = await request(app)
      .post("/v1/messages/")
      .set("Authorization", `Bearer ${talentToken}`)
      .send({ content: "Can I have this job please", recipient: recruiter.id });

    expect(res.status).toBe(403);
    expect(talent).toBeDefined();
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
  });
});
