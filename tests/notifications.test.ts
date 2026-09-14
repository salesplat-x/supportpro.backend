/**
 * Notification tests — CRUD with ownership checks and soft-delete.
 * Also includes conversation listing tests.
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
  createNotification,
  createConversationWithMessage,
} from "./helpers/fixtures.js";
import { Notification } from "../src/entities/Notification.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
    sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
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

afterEach(async () => {
  await clearAllTables();
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// POST /v1/notifications/ — create notification
// ---------------------------------------------------------------------------

describe("POST /v1/notifications/ — create notification", () => {
  it("Creates notification for authenticated user → 201", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/notifications/")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "Hello World" });
    expect(res.status).toBe(201);
    expect(res.body.data.notification.message).toBe("Hello World");
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app).post("/v1/notifications/").send({ message: "Test" });
    expect(res.status).toBe(401);
  });

  it("Missing message → 400", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/notifications/")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("Creates notification with a title → 201", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/notifications/")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "Hello World", title: "A short title" });
    expect(res.status).toBe(201);
    expect(res.body.data.notification.title).toBe("A short title");
  });
});

// ---------------------------------------------------------------------------
// GET /v1/notifications/ — list notifications
// ---------------------------------------------------------------------------

describe("GET /v1/notifications/ — list notifications", () => {
  it("Returns user's non-deleted notifications → 200", async () => {
    const { user, token } = await createTalent();
    await createNotification(user, { message: "Visible" });
    await createNotification(user, { message: "Deleted", deleted: true });

    const res = await request(app)
      .get("/v1/notifications/")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const notifications = res.body.data.notifications ?? res.body.data ?? [];
    expect(notifications.some((n: Notification) => n.message === "Visible")).toBe(true);
    expect(notifications.some((n: Notification) => n.message === "Deleted")).toBe(false);
  });

  it("Another user's notifications not included", async () => {
    const { user: userA, token: tokenA } = await createTalent();
    const { user: userB } = await createTalent();
    await createNotification(userA, { message: "User A notification" });
    await createNotification(userB, { message: "User B notification" });

    const res = await request(app)
      .get("/v1/notifications/")
      .set("Authorization", `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    const notifications = res.body.data.notifications ?? res.body.data ?? [];
    expect(notifications.every((n: Notification) => n.userId === userA.id)).toBe(true);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app).get("/v1/notifications/");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/notifications/:id — single notification
// ---------------------------------------------------------------------------

describe("GET /v1/notifications/:id — single notification", () => {
  it("Returns notification and marks as read → 200", async () => {
    const { user, token } = await createTalent();
    const n = await createNotification(user, { isRead: false });

    const res = await request(app)
      .get(`/v1/notifications/${n.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);

    const updated = await testDataSource
      .getRepository(Notification)
      .findOne({ where: { id: n.id } });
    expect(updated!.isRead).toBe(true);
  });

  it("Another user's notification → 403", async () => {
    const { user: userA } = await createTalent();
    const { token: tokenB } = await createTalent();
    const n = await createNotification(userA);

    const res = await request(app)
      .get(`/v1/notifications/${n.id}`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(403);
  });

  it("Non-existent → 404", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .get("/v1/notifications/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/notifications/:id — soft-delete
// ---------------------------------------------------------------------------

describe("DELETE /v1/notifications/:id — soft-delete", () => {
  it("Soft-deletes notification (deleted=true) → 200", async () => {
    const { user, token } = await createTalent();
    const n = await createNotification(user);

    const res = await request(app)
      .delete(`/v1/notifications/${n.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const updated = await testDataSource
      .getRepository(Notification)
      .findOne({ where: { id: n.id } });
    expect(updated!.deleted).toBe(true);
  });

  it("Another user's notification → 403", async () => {
    const { user: userA } = await createTalent();
    const { token: tokenB } = await createTalent();
    const n = await createNotification(userA);

    const res = await request(app)
      .delete(`/v1/notifications/${n.id}`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(403);
  });

  it("Non-existent → 404", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .delete("/v1/notifications/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("Deleted notification does not appear in list", async () => {
    const { user, token } = await createTalent();
    const n = await createNotification(user, { message: "Will be deleted" });

    await request(app).delete(`/v1/notifications/${n.id}`).set("Authorization", `Bearer ${token}`);

    const listRes = await request(app)
      .get("/v1/notifications/")
      .set("Authorization", `Bearer ${token}`);

    const notifications = listRes.body.data.notifications ?? listRes.body.data ?? [];
    expect(notifications.some((notif: Notification) => notif.id === n.id)).toBe(false);
  });
});

describe("PATCH /v1/notifications/read-all", () => {
  it("marks every unread notification as read", async () => {
    const { user, token } = await createTalent();
    await createNotification(user, { message: "First" });
    await createNotification(user, { message: "Second" });
    await createNotification(user, { message: "Already read", isRead: true });

    const res = await request(app)
      .patch("/v1/notifications/read-all")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBe(2);

    const listRes = await request(app)
      .get("/v1/notifications/")
      .set("Authorization", `Bearer ${token}`);

    expect(listRes.body.data.unReadCount).toBe(0);
    expect(listRes.body.data.notifications.every((n: Notification) => n.isRead)).toBe(true);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app).patch("/v1/notifications/read-all");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/conversations/ — list conversations
// ---------------------------------------------------------------------------

describe("GET /v1/conversations/ — list conversations", () => {
  it("Returns conversations where user is participant → 200", async () => {
    const { user: sender, token } = await createTalent();
    const { user: recipient } = await createRecruiter();
    await createConversationWithMessage(sender, recipient);

    const res = await request(app)
      .get("/v1/conversations/")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const convs = res.body.data.conversations ?? res.body.data ?? [];
    expect(Array.isArray(convs)).toBe(true);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app).get("/v1/conversations/");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/conversations/:id — single conversation
// ---------------------------------------------------------------------------

describe("GET /v1/conversations/:id — single conversation", () => {
  it("Returns conversation if participant → 200", async () => {
    const { user: sender, token } = await createTalent();
    const { user: recipient } = await createRecruiter();
    const { conversation } = await createConversationWithMessage(sender, recipient);

    const res = await request(app)
      .get(`/v1/conversations/${conversation.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("Non-existent → 404", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .get("/v1/conversations/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
