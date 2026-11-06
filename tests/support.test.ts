import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { Feedback } from "../src/entities/Feedback.js";
import { Notification } from "../src/entities/Notification.js";
import { OrganizationMember } from "../src/entities/OrganizationMember.js";
import { User } from "../src/entities/User.js";
import * as entitlements from "../src/services/entitlements.js";
import {
  createAdmin,
  createErrorLog,
  createOrganization,
  createRecruiter,
  createTalent,
} from "./helpers/fixtures.js";
import { apiData } from "./helpers/http.js";

const mockSendSupportReply = jest.fn();

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
    sendPasswordReset: jest.fn().mockResolvedValue(undefined),
    sendSupportReply: mockSendSupportReply,
  })),
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
  mockSendSupportReply.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await clearAllTables();
});

const feedbackRepo = () => testDataSource.getRepository(Feedback);

const insertRequest = async (userId: string, overrides: Partial<Feedback> = {}) =>
  feedbackRepo().save(feedbackRepo().create({ userId, message: "I need help", ...overrides }));

const backdate = (id: string, interval: string) =>
  testDataSource.query(
    `UPDATE "feedback" SET "createdAt" = NOW() - INTERVAL '${interval}' WHERE "id" = $1`,
    [id]
  );

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface InboxData {
  feedback: Array<{
    id: string;
    status: string;
    preview: string;
    user: { id: string; email: string };
  }>;
  total: number;
  counts: Record<string, number>;
}

const inbox = async (token: string, query = "") => {
  const res = await request(app).get(`/v1/feedback${query}`).set(bearer(token));
  expect(res.status).toBe(200);
  return apiData<InboxData>(res);
};

describe("POST /v1/feedback", () => {
  it("saves a talent's request as unread", async () => {
    const { user, token } = await createTalent();
    const res = await request(app)
      .post("/v1/feedback")
      .set(bearer(token))
      .send({ message: "  My CV won't upload  ", topic: "bug" });

    expect(res.status).toBe(201);
    const { request: sent } = apiData<{ request: Record<string, unknown> }>(res);
    expect(sent).toMatchObject({
      message: "My CV won't upload",
      topic: "bug",
      seen: false,
      reply: null,
    });
    const row = await feedbackRepo().findOneByOrFail({ id: sent["id"] as string });
    expect(row).toMatchObject({ userId: user.id, isRead: false, repliedAt: null });
  });

  it("saves a recruiter's request without a topic", async () => {
    const { token } = await createRecruiter();
    const res = await request(app).post("/v1/feedback").set(bearer(token)).send({ message: "Hi" });
    expect(res.status).toBe(201);
    expect(apiData<{ request: { topic: null } }>(res).request.topic).toBeNull();
  });

  it("refuses the admin and unverified users", async () => {
    const admin = await createAdmin();
    const unverified = await createTalent({ emailVerifiedAt: null });
    for (const token of [admin.token, unverified.token]) {
      const res = await request(app)
        .post("/v1/feedback")
        .set(bearer(token))
        .send({ message: "Hi" });
      expect(res.status).toBe(403);
    }
    expect(await feedbackRepo().count()).toBe(0);
  });

  it.each([
    [{ message: "" }],
    [{ message: "   \n  " }],
    [{ message: 42 }],
    [{ message: "x".repeat(5001) }],
    [{ message: "Hi", topic: "sales" }],
    [{ message: "Hi", clientRequestId: "not-a-uuid" }],
  ])("rejects %j with 400", async (body) => {
    const { token } = await createTalent();
    const res = await request(app).post("/v1/feedback").set(bearer(token)).send(body);
    expect(res.status).toBe(400);
    expect(await feedbackRepo().count()).toBe(0);
  });

  it("accepts a message of exactly 5,000 characters", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/feedback")
      .set(bearer(token))
      .send({ message: "x".repeat(5000) });
    expect(res.status).toBe(201);
  });

  it("returns the first request when the same clientRequestId is sent again", async () => {
    const { token } = await createTalent();
    const body = { message: "Hello", clientRequestId: "6f1c2b8e-2a4d-4c1e-9d62-0f6c9a1e2b3c" };
    const first = await request(app).post("/v1/feedback").set(bearer(token)).send(body);
    const second = await request(app).post("/v1/feedback").set(bearer(token)).send(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const id = (res: typeof first) => apiData<{ request: { id: string } }>(res).request.id;
    expect(id(second)).toBe(id(first));
    expect(await feedbackRepo().count()).toBe(1);
  });

  it("keeps one row when two submits with the same clientRequestId race", async () => {
    const { token } = await createTalent();
    const body = { message: "Hello", clientRequestId: "1d0f3a9e-7b2c-4e8f-a1d4-5c6b7a8e9f00" };
    const results = await Promise.all([
      request(app).post("/v1/feedback").set(bearer(token)).send(body),
      request(app).post("/v1/feedback").set(bearer(token)).send(body),
    ]);

    expect(results.map((res) => res.status).sort()).toEqual([200, 201]);
    expect(await feedbackRepo().count()).toBe(1);
  });

  it("lets two users reuse the same clientRequestId", async () => {
    const a = await createTalent();
    const b = await createTalent();
    const body = { message: "Hello", clientRequestId: "2b7e1a3c-9d4f-4a6b-8c1e-3f5a7b9c1d2e" };
    await request(app).post("/v1/feedback").set(bearer(a.token)).send(body).expect(201);
    await request(app).post("/v1/feedback").set(bearer(b.token)).send(body).expect(201);
    expect(await feedbackRepo().count()).toBe(2);
  });
});

describe("GET /v1/feedback/mine", () => {
  it("returns only the caller's requests, oldest first, with no admin fields", async () => {
    const { user, token } = await createTalent();
    const other = await createTalent();
    const older = await insertRequest(user.id, { message: "First" });
    await backdate(older.id, "2 hours");
    await insertRequest(user.id, {
      message: "Second",
      isRead: true,
      reply: "Here you go",
      repliedAt: new Date(),
      draftReply: "secret draft",
    });
    await insertRequest(other.user.id, { message: "Not mine" });

    const res = await request(app).get("/v1/feedback/mine").set(bearer(token));
    expect(res.status).toBe(200);
    const { requests } = apiData<{ requests: Array<Record<string, unknown>> }>(res);
    expect(requests.map((item) => item["message"])).toEqual(["First", "Second"]);
    for (const item of requests) {
      expect(Object.keys(item).sort()).toEqual(
        ["createdAt", "id", "message", "repliedAt", "reply", "seen", "subject", "topic"].sort()
      );
    }
    expect(requests[1]).toMatchObject({ seen: true, reply: "Here you go" });
  });

  it("is not open to the admin", async () => {
    const { token } = await createAdmin();
    const res = await request(app).get("/v1/feedback/mine").set(bearer(token));
    expect(res.status).toBe(403);
  });
});

describe("GET /v1/feedback (admin inbox)", () => {
  it("works out each status and counts them", async () => {
    const { token } = await createAdmin();
    const talent = (await createTalent()).user;
    const unread = await insertRequest(talent.id, { message: "unread" });
    const read = await insertRequest(talent.id, { message: "read", isRead: true });
    const replied = await insertRequest(talent.id, {
      message: "replied",
      isRead: true,
      reply: "Done",
      repliedAt: new Date(),
    });
    const overdue = await insertRequest(talent.id, { message: "overdue" });
    await backdate(overdue.id, "49 hours");

    const data = await inbox(token);
    const statusOf = Object.fromEntries(data.feedback.map((row) => [row.id, row.status]));
    expect(statusOf).toEqual({
      [unread.id]: "unread",
      [read.id]: "read",
      [replied.id]: "replied",
      [overdue.id]: "unreplied",
    });
    expect(data.counts).toEqual({ unread: 1, read: 1, unreplied: 1, replied: 1 });
    expect(data.total).toBe(4);
    expect(data.feedback.map((row) => row.status)).toEqual([
      "unreplied",
      "unread",
      "read",
      "replied",
    ]);
  });

  it("puts the 48-hour line in the right place", async () => {
    const { token } = await createAdmin();
    const talent = (await createTalent()).user;
    const justUnder = await insertRequest(talent.id);
    await backdate(justUnder.id, "47 hours 59 minutes");
    const justOver = await insertRequest(talent.id, { isRead: true });
    await backdate(justOver.id, "48 hours 1 minute");
    const lateReply = await insertRequest(talent.id, { reply: "Sorry", repliedAt: new Date() });
    await backdate(lateReply.id, "49 hours");

    const statusOf = Object.fromEntries(
      (await inbox(token)).feedback.map((row) => [row.id, row.status])
    );
    expect(statusOf[justUnder.id]).toBe("unread");
    expect(statusOf[justOver.id]).toBe("unreplied");
    expect(statusOf[lateReply.id]).toBe("replied");
  });

  it("filters by status but keeps counts for every status", async () => {
    const { token } = await createAdmin();
    const talent = (await createTalent()).user;
    await insertRequest(talent.id);
    const overdue = await insertRequest(talent.id);
    await backdate(overdue.id, "3 days");

    const data = await inbox(token, "?status=unreplied");
    expect(data.feedback.map((row) => row.id)).toEqual([overdue.id]);
    expect(data.total).toBe(1);
    expect(data.counts).toMatchObject({ unread: 1, unreplied: 1 });
  });

  it("sorts newest first by date when asked", async () => {
    const { token } = await createAdmin();
    const talent = (await createTalent()).user;
    const older = await insertRequest(talent.id, { message: "older" });
    await backdate(older.id, "3 hours");
    const newer = await insertRequest(talent.id, { message: "newer", isRead: true });

    const desc = await inbox(token, "?sortBy=createdAt&sort=desc");
    expect(desc.feedback.map((row) => row.id)).toEqual([newer.id, older.id]);
    const asc = await inbox(token, "?sortBy=createdAt&sort=asc");
    expect(asc.feedback.map((row) => row.id)).toEqual([older.id, newer.id]);
  });

  it("matches % and _ in a search literally", async () => {
    const { token } = await createAdmin();
    const talent = (await createTalent()).user;
    const percent = await insertRequest(talent.id, { message: "Upload stuck at 100% done" });
    await insertRequest(talent.id, { message: "Upload stuck at 100 percent" });
    const underscore = await insertRequest(talent.id, { message: "Field snake_case breaks" });
    await insertRequest(talent.id, { message: "Field snakeXcase breaks" });

    expect((await inbox(token, "?search=%25")).feedback.map((row) => row.id)).toEqual([percent.id]);
    expect((await inbox(token, "?search=e_c")).feedback.map((row) => row.id)).toEqual([
      underscore.id,
    ]);
  });

  it("searches by name and email", async () => {
    const { token } = await createAdmin();
    const ada = (await createTalent({ firstName: "Ada", lastName: "Lovelace" })).user;
    const bob = (await createTalent({ firstName: "Bob", lastName: "Stone" })).user;
    const adaRequest = await insertRequest(ada.id);
    await insertRequest(bob.id);

    expect((await inbox(token, "?search=ada%20love")).feedback.map((row) => row.id)).toEqual([
      adaRequest.id,
    ]);
    const byEmail = await inbox(token, `?search=${encodeURIComponent(ada.email)}`);
    expect(byEmail.feedback.map((row) => row.id)).toEqual([adaRequest.id]);
  });

  it("returns a short user summary and a preview, not the whole message", async () => {
    const { token } = await createAdmin();
    const talent = (await createTalent()).user;
    await insertRequest(talent.id, { message: "y".repeat(400) });

    const [row] = (await inbox(token)).feedback;
    expect(row!.preview).toHaveLength(160);
    expect(Object.keys(row!.user).sort()).toEqual(
      ["email", "firstName", "id", "lastName", "profileImageUrl", "userRole"].sort()
    );
  });

  it("caps the page at 100 rows", async () => {
    const { token } = await createAdmin();
    const talent = (await createTalent()).user;
    await testDataSource.query(
      `INSERT INTO "feedback" ("user_id", "message") SELECT $1, 'bulk ' || n FROM generate_series(1, 105) n`,
      [talent.id]
    );
    const data = await inbox(token, "?limit=500");
    expect(data.feedback).toHaveLength(100);
    expect(data.total).toBe(105);
  });

  it("pages rows with the same timestamp without repeats or gaps", async () => {
    const { token } = await createAdmin();
    const talent = (await createTalent()).user;
    await testDataSource.query(
      `INSERT INTO "feedback" ("user_id", "message", "createdAt")
       SELECT $1, 'same time ' || n, '2026-11-01 10:00:00' FROM generate_series(1, 5) n`,
      [talent.id]
    );
    const seen: string[] = [];
    for (const offset of [0, 2, 4]) {
      const page = await inbox(token, `?sortBy=createdAt&limit=2&offset=${offset}`);
      seen.push(...page.feedback.map((row) => row.id));
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it.each([
    "?status=open",
    "?topic=sales",
    "?sortBy=name",
    "?sort=up",
    `?search=${"a".repeat(101)}`,
  ])("rejects %s with 400", async (query) => {
    const { token } = await createAdmin();
    const res = await request(app).get(`/v1/feedback${query}`).set(bearer(token));
    expect(res.status).toBe(400);
  });

  it("is closed to talents and recruiters", async () => {
    const talent = await createTalent();
    const recruiter = await createRecruiter();
    for (const token of [talent.token, recruiter.token]) {
      const res = await request(app).get("/v1/feedback").set(bearer(token));
      expect(res.status).toBe(403);
    }
  });

  it("shows a row written the old way, before this release's columns existed", async () => {
    const { token } = await createAdmin();
    const talent = (await createTalent()).user;
    await testDataSource.query(
      `INSERT INTO "feedback" ("user_id", "subject", "message", "isRead") VALUES ($1, 'Old', 'Old form', DEFAULT)`,
      [talent.id]
    );
    const [row] = (await inbox(token)).feedback;
    expect(row).toMatchObject({ status: "unread" });
  });
});

describe("GET /v1/feedback/:id", () => {
  it("returns the request with only that user's history, oldest first", async () => {
    const { token } = await createAdmin();
    const talent = (await createTalent()).user;
    const other = (await createTalent()).user;
    const first = await insertRequest(talent.id, {
      message: "first",
      reply: "ok",
      repliedAt: new Date(),
    });
    await backdate(first.id, "5 hours");
    const second = await insertRequest(talent.id, { message: "second" });
    await insertRequest(other.id, { message: "someone else" });

    const res = await request(app).get(`/v1/feedback/${second.id}`).set(bearer(token));
    expect(res.status).toBe(200);
    const data = apiData<{
      request: { id: string; status: string; user: { id: string } };
      history: Array<{ id: string }>;
    }>(res);
    expect(data.request).toMatchObject({
      id: second.id,
      status: "unread",
      user: { id: talent.id },
    });
    expect(data.history.map((item) => item.id)).toEqual([first.id, second.id]);
  });

  it("doesn't mark the request read", async () => {
    const { token } = await createAdmin();
    const talent = (await createTalent()).user;
    const row = await insertRequest(talent.id);
    await request(app).get(`/v1/feedback/${row.id}`).set(bearer(token)).expect(200);
    expect((await feedbackRepo().findOneByOrFail({ id: row.id })).isRead).toBe(false);
  });

  it("answers 404 for an unknown id and 400 for a bad one", async () => {
    const { token } = await createAdmin();
    const missing = await request(app)
      .get("/v1/feedback/2b7e1a3c-9d4f-4a6b-8c1e-3f5a7b9c1d2e")
      .set(bearer(token));
    expect(missing.status).toBe(404);
    const bad = await request(app).get("/v1/feedback/nope").set(bearer(token));
    expect(bad.status).toBe(400);
  });
});

describe("GET /v1/feedback/:id/user-context", () => {
  it("describes a talent without exposing CV text", async () => {
    const { token } = await createAdmin();
    const talent = (await createTalent({ firstName: "Tola", country: "Nigeria" })).user;
    await testDataSource.query(`UPDATE "users" SET "cvText" = 'PRIVATE CV' WHERE "id" = $1`, [
      talent.id,
    ]);
    const row = await insertRequest(talent.id);

    const res = await request(app).get(`/v1/feedback/${row.id}/user-context`).set(bearer(token));
    expect(res.status).toBe(200);
    const { context } = apiData<{ context: Record<string, Record<string, unknown> | null> }>(res);
    expect(context["account"]).toMatchObject({
      firstName: "Tola",
      country: "Nigeria",
      role: "talent",
    });
    expect(context["onboarding"]).toMatchObject({ stage: "complete_profile" });
    expect(context["talent"]).toMatchObject({ cvUploaded: false, applicationsByStatus: {} });
    expect(context["recruiter"]).toBeNull();
    expect(JSON.stringify(context)).not.toContain("PRIVATE CV");
  });

  it("describes a recruiter's company and plan", async () => {
    const { token } = await createAdmin();
    const recruiter = (await createRecruiter()).user;
    const org = await createOrganization(recruiter, { name: "Acme Hiring" });
    await testDataSource.getRepository(OrganizationMember).save({
      userId: recruiter.id,
      organizationId: org.id,
      workEmail: recruiter.email,
      role: "owner",
    });
    const row = await insertRequest(recruiter.id);

    const res = await request(app).get(`/v1/feedback/${row.id}/user-context`).set(bearer(token));
    const { context } = apiData<{
      context: {
        recruiter: { organization: Record<string, unknown>; plan: Record<string, unknown> };
      };
    }>(res);
    expect(context.recruiter.organization).toMatchObject({
      name: "Acme Hiring",
      memberRole: "owner",
      teamSize: 1,
    });
    expect(context.recruiter.plan).toMatchObject({ billingPlan: expect.any(String) });
  });

  it("still answers when one part fails, leaving that part empty", async () => {
    const { token } = await createAdmin();
    const recruiter = (await createRecruiter()).user;
    await createOrganization(recruiter);
    const row = await insertRequest(recruiter.id);
    jest.spyOn(entitlements, "getOrganizationUsage").mockRejectedValue(new Error("usage down"));

    const res = await request(app).get(`/v1/feedback/${row.id}/user-context`).set(bearer(token));
    expect(res.status).toBe(200);
    const { context } = apiData<{
      context: { recruiter: { plan: unknown; organization: unknown } };
    }>(res);
    expect(context.recruiter.plan).toBeNull();
    expect(context.recruiter.organization).not.toBeNull();
  });

  it("includes the user's recent errors, trimmed", async () => {
    const { token } = await createAdmin();
    const talent = (await createTalent()).user;
    await createErrorLog({ userId: talent.id, message: "z".repeat(500), stack: "SECRET STACK" });
    const row = await insertRequest(talent.id);

    const res = await request(app).get(`/v1/feedback/${row.id}/user-context`).set(bearer(token));
    const { context } = apiData<{ context: { recentErrors: Array<{ message: string }> } }>(res);
    expect(context.recentErrors).toHaveLength(1);
    expect(context.recentErrors[0]!.message).toHaveLength(200);
    expect(JSON.stringify(context)).not.toContain("SECRET STACK");
  });
});

describe("read, unread and drafts", () => {
  it("marks a request read and unread", async () => {
    const { token } = await createAdmin();
    const row = await insertRequest((await createTalent()).user.id);

    const read = await request(app).patch(`/v1/feedback/${row.id}/read`).set(bearer(token));
    expect(apiData<{ request: { status: string } }>(read).request.status).toBe("read");
    const unread = await request(app).patch(`/v1/feedback/${row.id}/unread`).set(bearer(token));
    expect(apiData<{ request: { status: string } }>(unread).request.status).toBe("unread");
  });

  it("won't mark a replied request unread or change its draft", async () => {
    const { token } = await createAdmin();
    const row = await insertRequest((await createTalent()).user.id, {
      isRead: true,
      reply: "Done",
      repliedAt: new Date(),
    });
    const unread = await request(app).patch(`/v1/feedback/${row.id}/unread`).set(bearer(token));
    expect(unread.status).toBe(409);
    const draft = await request(app)
      .put(`/v1/feedback/${row.id}/draft`)
      .set(bearer(token))
      .send({ draft: "late" });
    expect(draft.status).toBe(409);
  });

  it("answers 404 for read, unread and draft on an unknown id", async () => {
    const { token } = await createAdmin();
    const id = "2b7e1a3c-9d4f-4a6b-8c1e-3f5a7b9c1d2e";
    await request(app).patch(`/v1/feedback/${id}/read`).set(bearer(token)).expect(404);
    await request(app).patch(`/v1/feedback/${id}/unread`).set(bearer(token)).expect(404);
    await request(app)
      .put(`/v1/feedback/${id}/draft`)
      .set(bearer(token))
      .send({ draft: "x" })
      .expect(404);
  });

  it("saves a draft and clears it when empty", async () => {
    const { token } = await createAdmin();
    const row = await insertRequest((await createTalent()).user.id);

    const saved = await request(app)
      .put(`/v1/feedback/${row.id}/draft`)
      .set(bearer(token))
      .send({ draft: "Working on it" });
    expect(apiData<{ draftReply: string }>(saved).draftReply).toBe("Working on it");
    await request(app)
      .put(`/v1/feedback/${row.id}/draft`)
      .set(bearer(token))
      .send({ draft: "  " })
      .expect(200);
    expect((await feedbackRepo().findOneByOrFail({ id: row.id })).draftReply).toBeNull();
  });

  it("rejects a draft that is too long or not text", async () => {
    const { token } = await createAdmin();
    const row = await insertRequest((await createTalent()).user.id);
    for (const draft of ["x".repeat(5001), 7]) {
      const res = await request(app)
        .put(`/v1/feedback/${row.id}/draft`)
        .set(bearer(token))
        .send({ draft });
      expect(res.status).toBe(400);
    }
  });

  it("keeps drafts and read changes away from talents", async () => {
    const talent = await createTalent();
    const row = await insertRequest(talent.user.id);
    await request(app).patch(`/v1/feedback/${row.id}/read`).set(bearer(talent.token)).expect(403);
    await request(app)
      .put(`/v1/feedback/${row.id}/draft`)
      .set(bearer(talent.token))
      .send({ draft: "x" })
      .expect(403);
    await request(app)
      .post(`/v1/feedback/${row.id}/reply`)
      .set(bearer(talent.token))
      .send({ reply: "x" })
      .expect(403);
  });
});

describe("POST /v1/feedback/:id/reply", () => {
  it("saves the reply, notifies the user and emails them once", async () => {
    const admin = await createAdmin();
    const talent = (await createTalent()).user;
    const row = await insertRequest(talent.id, {
      message: "Where is my score?",
      draftReply: "wip",
    });

    const res = await request(app)
      .post(`/v1/feedback/${row.id}/reply`)
      .set(bearer(admin.token))
      .send({ reply: "  Your score is on the dashboard.\n\nIt updates daily.  " });

    expect(res.status).toBe(200);
    expect(apiData<{ request: Record<string, unknown> }>(res).request).toMatchObject({
      status: "replied",
      reply: "Your score is on the dashboard.\n\nIt updates daily.",
      replyEmailStatus: "sent",
      draftReply: null,
    });
    const saved = await feedbackRepo().findOneByOrFail({ id: row.id });
    expect(saved).toMatchObject({ isRead: true, repliedById: admin.user.id });

    const notifications = await testDataSource
      .getRepository(Notification)
      .find({ where: { userId: talent.id } });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      type: "support_reply",
      link: "/talentDashboard/support",
      organizationId: null,
      dedupeKey: `support_reply:${row.id}`,
    });

    expect(mockSendSupportReply).toHaveBeenCalledTimes(1);
    expect(mockSendSupportReply).toHaveBeenCalledWith(
      expect.objectContaining({
        to: talent.email,
        paragraphs: ["Your score is on the dashboard.", "It updates daily."],
        quote: "Where is my score?",
        idempotencyKey: `support-reply/${row.id}`,
        ctaUrl: expect.stringMatching(/\/talentDashboard\/support$/),
      })
    );
  });

  it("links a recruiter to the recruiter support page", async () => {
    const admin = await createAdmin();
    const recruiter = (await createRecruiter()).user;
    const row = await insertRequest(recruiter.id);
    await request(app)
      .post(`/v1/feedback/${row.id}/reply`)
      .set(bearer(admin.token))
      .send({ reply: "Hi" })
      .expect(200);
    const [notification] = await testDataSource
      .getRepository(Notification)
      .find({ where: { userId: recruiter.id } });
    expect(notification!.link).toBe("/recruiterDashboard/support");
  });

  it("refuses a second reply", async () => {
    const admin = await createAdmin();
    const row = await insertRequest((await createTalent()).user.id);
    await request(app)
      .post(`/v1/feedback/${row.id}/reply`)
      .set(bearer(admin.token))
      .send({ reply: "One" })
      .expect(200);
    const again = await request(app)
      .post(`/v1/feedback/${row.id}/reply`)
      .set(bearer(admin.token))
      .send({ reply: "Two" });
    expect(again.status).toBe(409);
    expect((await feedbackRepo().findOneByOrFail({ id: row.id })).reply).toBe("One");
    expect(mockSendSupportReply).toHaveBeenCalledTimes(1);
  });

  it("sends exactly one reply when two race", async () => {
    const admin = await createAdmin();
    const talent = (await createTalent()).user;
    const row = await insertRequest(talent.id);
    const results = await Promise.all(
      ["A", "B"].map((reply) =>
        request(app).post(`/v1/feedback/${row.id}/reply`).set(bearer(admin.token)).send({ reply })
      )
    );
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(
      await testDataSource.getRepository(Notification).count({ where: { userId: talent.id } })
    ).toBe(1);
    expect(mockSendSupportReply).toHaveBeenCalledTimes(1);
  });

  it.each([[{ reply: "" }], [{ reply: "   " }], [{ reply: "x".repeat(5001) }], [{}]])(
    "rejects %j with 400",
    async (body) => {
      const admin = await createAdmin();
      const row = await insertRequest((await createTalent()).user.id);
      const res = await request(app)
        .post(`/v1/feedback/${row.id}/reply`)
        .set(bearer(admin.token))
        .send(body);
      expect(res.status).toBe(400);
      expect((await feedbackRepo().findOneByOrFail({ id: row.id })).repliedAt).toBeNull();
    }
  );

  it("answers 404 for an unknown request", async () => {
    const admin = await createAdmin();
    const res = await request(app)
      .post("/v1/feedback/2b7e1a3c-9d4f-4a6b-8c1e-3f5a7b9c1d2e/reply")
      .set(bearer(admin.token))
      .send({ reply: "Hi" });
    expect(res.status).toBe(404);
  });

  it("shows the reply in the user's conversation", async () => {
    const admin = await createAdmin();
    const talent = await createTalent();
    const row = await insertRequest(talent.user.id);
    await request(app)
      .post(`/v1/feedback/${row.id}/reply`)
      .set(bearer(admin.token))
      .send({ reply: "Sorted" })
      .expect(200);

    const mine = await request(app).get("/v1/feedback/mine").set(bearer(talent.token));
    const [item] = apiData<{ requests: Array<Record<string, unknown>> }>(mine).requests;
    expect(item).toMatchObject({ reply: "Sorted", seen: true });
    expect(item).not.toHaveProperty("draftReply");
    expect(item).not.toHaveProperty("replyEmailStatus");
  });
});

describe("reply email failures and retries", () => {
  it("keeps the reply when the email fails, then sends it on retry with the same key", async () => {
    const admin = await createAdmin();
    const row = await insertRequest((await createTalent()).user.id);
    mockSendSupportReply.mockRejectedValueOnce(new Error("Resend is down"));

    const res = await request(app)
      .post(`/v1/feedback/${row.id}/reply`)
      .set(bearer(admin.token))
      .send({ reply: "Hi" });
    expect(res.status).toBe(200);
    expect(apiData<{ request: Record<string, unknown> }>(res).request).toMatchObject({
      status: "replied",
      replyEmailStatus: "failed",
      replyEmailError: "Resend is down",
    });

    const retry = await request(app)
      .post(`/v1/feedback/${row.id}/reply/email`)
      .set(bearer(admin.token));
    expect(retry.status).toBe(200);
    expect(apiData<{ request: Record<string, unknown> }>(retry).request).toMatchObject({
      replyEmailStatus: "sent",
      replyEmailError: null,
    });
    const keys = mockSendSupportReply.mock.calls.map(
      ([details]) => (details as { idempotencyKey: string }).idempotencyKey
    );
    expect(keys).toEqual([`support-reply/${row.id}`, `support-reply/${row.id}`]);
  });

  it("won't resend an email that was sent", async () => {
    const admin = await createAdmin();
    const row = await insertRequest((await createTalent()).user.id);
    await request(app)
      .post(`/v1/feedback/${row.id}/reply`)
      .set(bearer(admin.token))
      .send({ reply: "Hi" })
      .expect(200);
    const retry = await request(app)
      .post(`/v1/feedback/${row.id}/reply/email`)
      .set(bearer(admin.token));
    expect(retry.status).toBe(409);
    expect(mockSendSupportReply).toHaveBeenCalledTimes(1);
  });

  it("waits before resending an email left pending, then allows it", async () => {
    const admin = await createAdmin();
    const row = await insertRequest((await createTalent()).user.id, {
      isRead: true,
      reply: "Hi",
      repliedAt: new Date(),
      replyEmailStatus: "pending",
    });

    const tooSoon = await request(app)
      .post(`/v1/feedback/${row.id}/reply/email`)
      .set(bearer(admin.token));
    expect(tooSoon.status).toBe(409);

    await testDataSource.query(
      `UPDATE "feedback" SET "updated_at" = NOW() - INTERVAL '3 minutes' WHERE "id" = $1`,
      [row.id]
    );
    const later = await request(app)
      .post(`/v1/feedback/${row.id}/reply/email`)
      .set(bearer(admin.token));
    expect(later.status).toBe(200);
    expect(mockSendSupportReply).toHaveBeenCalledTimes(1);
  });

  it("won't email a request that has no reply", async () => {
    const admin = await createAdmin();
    const row = await insertRequest((await createTalent()).user.id);
    const res = await request(app)
      .post(`/v1/feedback/${row.id}/reply/email`)
      .set(bearer(admin.token));
    expect(res.status).toBe(409);
    expect(mockSendSupportReply).not.toHaveBeenCalled();
  });
});

describe("admin overview", () => {
  it("counts requests still waiting for a reply", async () => {
    const { token } = await createAdmin();
    const talent = (await createTalent()).user;
    await insertRequest(talent.id);
    await insertRequest(talent.id, { isRead: true });
    await insertRequest(talent.id, { reply: "Done", repliedAt: new Date() });

    const res = await request(app).get("/v1/admin/overview").set(bearer(token));
    expect(res.status).toBe(200);
    expect(apiData<{ kpis: { supportAwaitingReply: number } }>(res).kpis.supportAwaitingReply).toBe(
      2
    );
  });
});

describe("deleting the user", () => {
  it("keeps a reply when the admin who sent it is removed", async () => {
    const admin = await createAdmin();
    const row = await insertRequest((await createTalent()).user.id);
    await request(app)
      .post(`/v1/feedback/${row.id}/reply`)
      .set(bearer(admin.token))
      .send({ reply: "Hi" })
      .expect(200);
    await testDataSource.getRepository(User).delete(admin.user.id);
    const saved = await feedbackRepo().findOneByOrFail({ id: row.id });
    expect(saved).toMatchObject({ reply: "Hi", repliedById: null });
  });
});
