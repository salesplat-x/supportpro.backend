import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { Feedback } from "../src/entities/Feedback.js";
import { MAX_DURABLE_ATTEMPTS } from "../src/utils/durableJobs.js";
import { AiConfigError, ValidationError } from "../src/utils/errors";
import { composeSupportReply } from "../src/utils/integrations/openai.js";
import {
  draftSupportReplyNow,
  reconcileDueSupportDrafts,
  sanitizeSupportDraft,
  triggerSupportDraft,
} from "../src/services/supportAi.js";
import {
  createAdmin,
  createOrganization,
  createRecruiter,
  createTalent,
} from "./helpers/fixtures.js";
import { apiData } from "./helpers/http.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  composeSupportReply: jest.fn(),
}));

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
    sendSupportReply: jest.fn().mockResolvedValue(undefined),
  })),
}));

const mockCompose = composeSupportReply as jest.Mock;

const aiReply = (content: unknown) => ({
  message: { content: typeof content === "string" ? content : JSON.stringify(content) },
});

const SIMPLE = {
  complexity: "simple",
  reply: "Hi Tola, upload your CV on your profile.",
  note: "No CV yet.",
};
const COMPLEX = {
  complexity: "complex",
  reply: "Hi, we'll look into the refund.",
  note: "Asks for a refund.",
};

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

beforeEach(() => {
  mockCompose.mockReset().mockResolvedValue(aiReply(SIMPLE));
});

afterEach(async () => {
  await waitForDrafts();
  await clearAllTables();
});

const feedbackRepo = () => testDataSource.getRepository(Feedback);
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const waitFor = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting");
};

const waitForDrafts = () =>
  waitFor(async () => {
    const [counted] = (await testDataSource.query(
      `SELECT COUNT(*)::int AS count FROM "feedback"
       WHERE "ai_draft_status" = 'pending' AND "ai_draft_locked_at" > NOW() - INTERVAL '5 minutes'`
    )) as Array<{ count: number }>;
    return counted!.count === 0;
  });

const row = (id: string) => feedbackRepo().findOneByOrFail({ id });

const pendingRequest = async (userId: string, overrides: Partial<Feedback> = {}) =>
  feedbackRepo().save(
    feedbackRepo().create({
      userId,
      message: "My CV won't upload",
      aiDraftStatus: "pending",
      ...overrides,
    })
  );

const submit = async (
  token: string,
  body: Record<string, unknown> = { message: "My CV won't upload" }
) => {
  const res = await request(app).post("/v1/feedback").set(bearer(token)).send(body);
  expect([200, 201]).toContain(res.status);
  return apiData<{ request: { id: string } }>(res).request.id;
};

const settled = async (id: string) => {
  await waitFor(async () => (await row(id)).aiDraftStatus !== "pending");
  return row(id);
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("sanitizeSupportDraft", () => {
  it("reads a simple draft", () => {
    expect(
      sanitizeSupportDraft(JSON.stringify({ complexity: " Simple ", reply: " Hi ", note: " n " }))
    ).toEqual({
      complexity: "simple",
      reply: "Hi",
      note: "n",
    });
  });

  it.each([
    ["an unknown complexity", { complexity: "easy", reply: "Hi", note: "" }],
    ["a simple answer with no reply", { complexity: "simple", reply: "   ", note: "" }],
    ["a missing complexity", { reply: "Hi" }],
  ])("treats %s as complex", (_label, content) => {
    expect(sanitizeSupportDraft(JSON.stringify(content)).complexity).toBe("complex");
  });

  it.each([
    ["nothing", null],
    ["empty text", ""],
    ["bad JSON", "{not json"],
    [
      "a reply over 5,000 characters",
      JSON.stringify({ complexity: "simple", reply: "x".repeat(5001) }),
    ],
  ])("rejects %s so the job retries", (_label, content) => {
    expect(() => sanitizeSupportDraft(content)).toThrow(ValidationError);
  });

  it("cuts a long note instead of failing", () => {
    const draft = sanitizeSupportDraft(
      JSON.stringify({ complexity: "simple", reply: "Hi", note: "n".repeat(900) })
    );
    expect(draft.note).toHaveLength(500);
  });
});

describe("drafting on arrival", () => {
  it("drafts a simple request and leaves the admin's draft alone", async () => {
    const { token } = await createTalent({ firstName: "Tola" });
    const id = await submit(token);

    const saved = await settled(id);
    expect(saved).toMatchObject({
      aiDraftStatus: "drafted",
      aiDraft: SIMPLE.reply,
      aiNote: SIMPLE.note,
      draftReply: null,
      aiDraftAttempts: 0,
      aiDraftLockedAt: null,
    });
  });

  it("leaves a complex request for the admin, with a note and no draft", async () => {
    mockCompose.mockResolvedValue(aiReply(COMPLEX));
    const { token } = await createTalent();
    const saved = await settled(await submit(token));
    expect(saved).toMatchObject({ aiDraftStatus: "complex", aiDraft: null, aiNote: COMPLEX.note });
  });

  it("never touches the admin's own draft", async () => {
    const talent = (await createTalent()).user;
    const pending = await pendingRequest(talent.id, { draftReply: "Admin is typing" });
    await triggerSupportDraft(pending.id);
    expect(await row(pending.id)).toMatchObject({
      draftReply: "Admin is typing",
      aiDraft: SIMPLE.reply,
    });
  });

  it("calls the AI once when a submit is retried", async () => {
    const { token } = await createTalent();
    const body = { message: "Hello", clientRequestId: "6f1c2b8e-2a4d-4c1e-9d62-0f6c9a1e2b3c" };
    const id = await submit(token, body);
    await settled(id);
    await submit(token, body);
    await waitForDrafts();
    expect(mockCompose).toHaveBeenCalledTimes(1);
  });

  it("sends the AI a trimmed snapshot and the request as its own message", async () => {
    const recruiter = (await createRecruiter({ firstName: "Ngozi", lastName: "Secretname" })).user;
    const org = await createOrganization(recruiter, { name: "Acme" });
    await testDataSource.query(`UPDATE "users" SET "cvText" = 'PRIVATE CV' WHERE "id" = $1`, [
      recruiter.id,
    ]);
    const earlier = await pendingRequest(recruiter.id, {
      message: "Earlier question",
      reply: "Earlier answer",
      repliedAt: new Date(),
      aiDraftStatus: null,
    });
    await testDataSource.query(
      `UPDATE "feedback" SET "createdAt" = NOW() - INTERVAL '2 days' WHERE "id" = $1`,
      [earlier.id]
    );
    const pending = await pendingRequest(recruiter.id, {
      message: "Why can't I publish?",
      topic: "jobs",
    });

    await triggerSupportDraft(pending.id);

    expect(mockCompose).toHaveBeenCalledTimes(1);
    const [context] = mockCompose.mock.calls[0] as [
      { snapshot: Record<string, unknown>; topic: string; message: string },
    ];
    expect(context.topic).toBe("jobs");
    expect(context.message).toBe("Why can't I publish?");
    const snapshot = JSON.stringify(context.snapshot);
    expect(snapshot).toContain("Ngozi");
    expect(snapshot).toContain("Acme");
    expect(snapshot).toContain("Earlier answer");
    expect(snapshot).not.toContain("Secretname");
    expect(snapshot).not.toContain(recruiter.email);
    expect(snapshot).not.toContain("PRIVATE CV");
    expect(snapshot).not.toContain(org.id);
    expect(snapshot).not.toContain("Why can't I publish?");
  });

  it("drafts a row the old code saved during the deploy window", async () => {
    const talent = (await createTalent()).user;
    const [inserted] = (await testDataSource.query(
      `INSERT INTO "feedback" ("user_id", "subject", "message", "isRead") VALUES ($1, 'Old', 'Old form', DEFAULT) RETURNING "id"`,
      [talent.id]
    )) as Array<{ id: string }>;
    expect((await row(inserted!.id)).aiDraftStatus).toBe("pending");

    await reconcileDueSupportDrafts();
    expect((await row(inserted!.id)).aiDraftStatus).toBe("drafted");
  });

  it("never drafts requests from before the support AI existed", async () => {
    const talent = (await createTalent()).user;
    const old = await pendingRequest(talent.id, { aiDraftStatus: null });
    await reconcileDueSupportDrafts();
    expect(mockCompose).not.toHaveBeenCalled();
    expect((await row(old.id)).aiDraftStatus).toBeNull();
  });
});

describe("retries and locks", () => {
  it("counts a failure, waits for the retry time, then drafts", async () => {
    const talent = (await createTalent()).user;
    const pending = await pendingRequest(talent.id);
    mockCompose.mockRejectedValueOnce(new Error("provider timeout"));

    await triggerSupportDraft(pending.id);
    const failed = await row(pending.id);
    expect(failed).toMatchObject({
      aiDraftStatus: "pending",
      aiDraftAttempts: 1,
      aiDraftLockedAt: null,
      aiDraftLastError: "provider timeout",
    });
    expect(failed.aiDraftNextRetryAt!.getTime()).toBeGreaterThan(Date.now());

    await reconcileDueSupportDrafts();
    expect(mockCompose).toHaveBeenCalledTimes(1);

    await testDataSource.query(
      `UPDATE "feedback" SET "ai_draft_next_retry_at" = NOW() - INTERVAL '1 second' WHERE "id" = $1`,
      [pending.id]
    );
    await reconcileDueSupportDrafts();
    expect(await row(pending.id)).toMatchObject({
      aiDraftStatus: "drafted",
      aiDraftLastError: null,
    });
  });

  it("retries bad AI output", async () => {
    const talent = (await createTalent()).user;
    const pending = await pendingRequest(talent.id);
    mockCompose.mockResolvedValueOnce(aiReply("{broken"));
    await triggerSupportDraft(pending.id);
    expect(await row(pending.id)).toMatchObject({ aiDraftStatus: "pending", aiDraftAttempts: 1 });
  });

  it("gives up after the last attempt", async () => {
    const talent = (await createTalent()).user;
    const pending = await pendingRequest(talent.id, { aiDraftAttempts: MAX_DURABLE_ATTEMPTS - 1 });
    mockCompose.mockRejectedValue(new Error("still down"));

    await triggerSupportDraft(pending.id);
    expect(await row(pending.id)).toMatchObject({
      aiDraftStatus: "failed",
      aiDraftAttempts: MAX_DURABLE_ATTEMPTS,
    });

    await testDataSource.query(
      `UPDATE "feedback" SET "ai_draft_next_retry_at" = NULL WHERE "id" = $1`,
      [pending.id]
    );
    mockCompose.mockClear();
    await reconcileDueSupportDrafts();
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it("doesn't use up an attempt when the AI setup is wrong", async () => {
    const talent = (await createTalent()).user;
    const pending = await pendingRequest(talent.id);
    mockCompose.mockRejectedValueOnce(
      new AiConfigError("OpenAI refused GPT-6 Luna with status 401.")
    );
    await triggerSupportDraft(pending.id);
    expect(await row(pending.id)).toMatchObject({ aiDraftStatus: "pending", aiDraftAttempts: 0 });
  });

  it("re-claims a row whose lock went stale, and skips one with a fresh lock", async () => {
    const talent = (await createTalent()).user;
    const stale = await pendingRequest(talent.id, { message: "stale" });
    const fresh = await pendingRequest(talent.id, { message: "fresh" });
    await testDataSource.query(
      `UPDATE "feedback" SET "ai_draft_locked_at" = NOW() - INTERVAL '6 minutes' WHERE "id" = $1`,
      [stale.id]
    );
    await testDataSource.query(
      `UPDATE "feedback" SET "ai_draft_locked_at" = NOW() - INTERVAL '1 minute' WHERE "id" = $1`,
      [fresh.id]
    );

    await reconcileDueSupportDrafts();
    expect((await row(stale.id)).aiDraftStatus).toBe("drafted");
    expect((await row(fresh.id)).aiDraftStatus).toBe("pending");
    expect(mockCompose).toHaveBeenCalledTimes(1);
    await testDataSource.query(
      `UPDATE "feedback" SET "ai_draft_locked_at" = NULL WHERE "id" = $1`,
      [fresh.id]
    );
  });

  it("runs once when the sweep and the submit race for the same row", async () => {
    const talent = (await createTalent()).user;
    const pending = await pendingRequest(talent.id);
    await Promise.all([
      triggerSupportDraft(pending.id),
      reconcileDueSupportDrafts(),
      triggerSupportDraft(pending.id),
    ]);
    expect(mockCompose).toHaveBeenCalledTimes(1);
  });

  it("drops a late result when the admin replied meanwhile", async () => {
    const admin = await createAdmin();
    const talent = (await createTalent()).user;
    const pending = await pendingRequest(talent.id);
    const slow = deferred<ReturnType<typeof aiReply>>();
    mockCompose.mockReturnValueOnce(slow.promise);

    const running = triggerSupportDraft(pending.id);
    await waitFor(async () => mockCompose.mock.calls.length === 1);
    await request(app)
      .post(`/v1/feedback/${pending.id}/reply`)
      .set(bearer(admin.token))
      .send({ reply: "Answered by hand" })
      .expect(200);
    slow.resolve(aiReply(SIMPLE));
    await running;

    expect(await row(pending.id)).toMatchObject({
      reply: "Answered by hand",
      aiDraft: null,
      aiDraftStatus: null,
    });
  });

  it("drops a late background result after a manual draft", async () => {
    const talent = (await createTalent()).user;
    const pending = await pendingRequest(talent.id);
    const slow = deferred<ReturnType<typeof aiReply>>();
    mockCompose.mockReturnValueOnce(slow.promise);

    const running = triggerSupportDraft(pending.id);
    await waitFor(async () => mockCompose.mock.calls.length === 1);
    await testDataSource.query(
      `UPDATE "feedback" SET "ai_draft_locked_at" = NOW() - INTERVAL '6 minutes' WHERE "id" = $1`,
      [pending.id]
    );
    mockCompose.mockResolvedValueOnce(aiReply({ ...SIMPLE, reply: "Manual draft" }));
    await draftSupportReplyNow(pending.id);
    slow.resolve(aiReply({ ...SIMPLE, reply: "Late background draft" }));
    await running;

    expect(await row(pending.id)).toMatchObject({
      aiDraft: "Manual draft",
      aiDraftStatus: "drafted",
    });
  });
});

describe("POST /v1/feedback/:id/ai-draft", () => {
  it("writes a draft even for a complex request", async () => {
    const admin = await createAdmin();
    const talent = (await createTalent()).user;
    const pending = await pendingRequest(talent.id, {
      aiDraftStatus: "complex",
      aiNote: "old note",
    });
    mockCompose.mockResolvedValue(aiReply(COMPLEX));

    const res = await request(app)
      .post(`/v1/feedback/${pending.id}/ai-draft`)
      .set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(apiData<{ request: Record<string, unknown> }>(res).request).toMatchObject({
      aiDraft: COMPLEX.reply,
      aiNote: COMPLEX.note,
      aiDraftStatus: "drafted",
      aiDraftBusy: false,
    });
  });

  it("answers 502 and changes nothing when the AI fails", async () => {
    const admin = await createAdmin();
    const talent = (await createTalent()).user;
    const pending = await pendingRequest(talent.id, { aiDraftStatus: "failed", aiDraft: null });
    mockCompose.mockRejectedValue(new Error("down"));

    const res = await request(app)
      .post(`/v1/feedback/${pending.id}/ai-draft`)
      .set(bearer(admin.token));
    expect(res.status).toBe(502);
    expect(await row(pending.id)).toMatchObject({ aiDraftStatus: "failed", aiDraft: null });
  });

  it("answers 502 when the AI writes no reply", async () => {
    const admin = await createAdmin();
    const talent = (await createTalent()).user;
    const pending = await pendingRequest(talent.id, { aiDraftStatus: "complex" });
    mockCompose.mockResolvedValue(aiReply({ complexity: "complex", reply: "", note: "?" }));
    const res = await request(app)
      .post(`/v1/feedback/${pending.id}/ai-draft`)
      .set(bearer(admin.token));
    expect(res.status).toBe(502);
  });

  it("waits while a background draft is running", async () => {
    const admin = await createAdmin();
    const talent = (await createTalent()).user;
    const pending = await pendingRequest(talent.id);
    await testDataSource.query(
      `UPDATE "feedback" SET "ai_draft_locked_at" = NOW() WHERE "id" = $1`,
      [pending.id]
    );

    const detail = await request(app).get(`/v1/feedback/${pending.id}`).set(bearer(admin.token));
    expect(apiData<{ request: { aiDraftBusy: boolean } }>(detail).request.aiDraftBusy).toBe(true);
    const res = await request(app)
      .post(`/v1/feedback/${pending.id}/ai-draft`)
      .set(bearer(admin.token));
    expect(res.status).toBe(409);
    expect(mockCompose).not.toHaveBeenCalled();
    await testDataSource.query(
      `UPDATE "feedback" SET "ai_draft_locked_at" = NULL WHERE "id" = $1`,
      [pending.id]
    );
  });

  it("lets only one of two clicks run", async () => {
    const admin = await createAdmin();
    const talent = (await createTalent()).user;
    const pending = await pendingRequest(talent.id, { aiDraftStatus: "complex" });
    const slow = deferred<ReturnType<typeof aiReply>>();
    mockCompose.mockReturnValueOnce(slow.promise);

    const first = request(app)
      .post(`/v1/feedback/${pending.id}/ai-draft`)
      .set(bearer(admin.token))
      .then((res) => res);
    await waitFor(async () => mockCompose.mock.calls.length === 1);
    const second = await request(app)
      .post(`/v1/feedback/${pending.id}/ai-draft`)
      .set(bearer(admin.token));
    slow.resolve(aiReply(SIMPLE));

    expect(second.status).toBe(409);
    expect((await first).status).toBe(200);
    expect(mockCompose).toHaveBeenCalledTimes(1);
  });

  it("refuses a replied request, an unknown id and non-admins", async () => {
    const admin = await createAdmin();
    const talent = await createTalent();
    const replied = await pendingRequest(talent.user.id, {
      reply: "Done",
      repliedAt: new Date(),
      aiDraftStatus: null,
    });

    await request(app)
      .post(`/v1/feedback/${replied.id}/ai-draft`)
      .set(bearer(admin.token))
      .expect(409);
    await request(app)
      .post("/v1/feedback/2b7e1a3c-9d4f-4a6b-8c1e-3f5a7b9c1d2e/ai-draft")
      .set(bearer(admin.token))
      .expect(404);
    await request(app)
      .post(`/v1/feedback/${replied.id}/ai-draft`)
      .set(bearer(talent.token))
      .expect(403);
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it("shows the AI fields in the admin list", async () => {
    const admin = await createAdmin();
    const talent = (await createTalent()).user;
    await pendingRequest(talent.id, { aiDraftStatus: "complex", aiNote: "Needs you" });
    const res = await request(app).get("/v1/feedback").set(bearer(admin.token));
    const [first] = apiData<{ feedback: Array<{ aiDraftStatus: string }> }>(res).feedback;
    expect(first!.aiDraftStatus).toBe("complex");
  });
});
