/**
 * Error log tests — Admin-only access.
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import { startTestDatabase, stopTestDatabase, clearAllTables } from "./helpers/db.js";
import { createTalent, createRecruiter, createAdmin, createErrorLog } from "./helpers/fixtures.js";
import { ErrorLog } from "../src/entities/ErrorLog.js";
import { ErrorLogLevel } from "../src/types/enums.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    sendWelcome: jest.fn().mockResolvedValue(undefined),
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
// Registration must never grant the admin role from client input
// ---------------------------------------------------------------------------

describe("POST /v1/auth/register — cannot self-register as admin", () => {
  it("ignores a client-supplied userRole and always creates a talent", async () => {
    const res = await request(app).post("/v1/auth/register").send({
      email: "tryadmin@example.com",
      firstName: "A",
      lastName: "B",
      password: "Password1!",
      userRole: "admin", // attempting to self-register as admin
    });
    expect(res.status).toBe(201);
    expect(res.body.data.user.userRole).toBe("talent");
  });

  it("there is no POST /v1/auth/register/admin route → 404", async () => {
    const res = await request(app).post("/v1/auth/register/admin").send({
      email: "sa@example.com",
      firstName: "SA",
      lastName: "User",
      password: "Password1!",
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/error-logs/ — list error logs (Admin only)
// ---------------------------------------------------------------------------

describe("GET /v1/error-logs/ — list error logs (Admin only)", () => {
  it("Admin fetches error logs → 200", async () => {
    const { token } = await createAdmin();
    await createErrorLog({ message: "Test error 1" });
    await createErrorLog({ message: "Test error 2" });

    const res = await request(app).get("/v1/error-logs/").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const logs = res.body.data.logs ?? res.body.data ?? [];
    expect(Array.isArray(logs)).toBe(true);
  });

  it("Recruiter cannot access error logs → 403", async () => {
    const { token } = await createRecruiter();
    const res = await request(app).get("/v1/error-logs/").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("Talent cannot access error logs → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app).get("/v1/error-logs/").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app).get("/v1/error-logs/");
    expect(res.status).toBe(401);
  });

  it("Filter by level=error returns only error logs", async () => {
    const { token } = await createAdmin();
    await createErrorLog({ level: ErrorLogLevel.Error });
    await createErrorLog({ level: ErrorLogLevel.Warn });

    const res = await request(app)
      .get("/v1/error-logs/")
      .set("Authorization", `Bearer ${token}`)
      .query({ level: "error" });

    expect(res.status).toBe(200);
    const logs = res.body.data.logs ?? res.body.data ?? [];
    if (logs.length > 0) {
      expect(logs.every((l: ErrorLog) => l.level === "error")).toBe(true);
    }
  });

  it("Filter by resolved=true returns only resolved logs", async () => {
    const { token } = await createAdmin();
    await createErrorLog({ resolved: true });
    await createErrorLog({ resolved: false });

    const res = await request(app)
      .get("/v1/error-logs/")
      .set("Authorization", `Bearer ${token}`)
      .query({ resolved: "true" });

    expect(res.status).toBe(200);
    const logs = res.body.data.logs ?? res.body.data ?? [];
    if (logs.length > 0) {
      expect(logs.every((l: ErrorLog) => l.resolved === true)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// GET /v1/error-logs/stats — stats (Admin only)
// ---------------------------------------------------------------------------

describe("GET /v1/error-logs/stats — stats (Admin only)", () => {
  it("Admin gets stats → 200", async () => {
    const { token } = await createAdmin();
    await createErrorLog({ resolved: false });
    await createErrorLog({ resolved: true });

    const res = await request(app)
      .get("/v1/error-logs/stats")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });

  it("Recruiter cannot access stats → 403", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .get("/v1/error-logs/stats")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/error-logs/:requestId/resolve — mark resolved (Admin only)
// ---------------------------------------------------------------------------

describe("PATCH /v1/error-logs/:requestId/resolve — mark resolved", () => {
  it("Admin marks an error log as resolved → 200", async () => {
    const { token } = await createAdmin();
    const log = await createErrorLog({ requestId: "REQ-001", resolved: false });

    const res = await request(app)
      .patch(`/v1/error-logs/${log.requestId ?? "REQ-001"}/resolve`)
      .set("Authorization", `Bearer ${token}`)
      .send({ resolvedBy: "admin" });

    expect(res.status).toBe(200);
  });

  it("Recruiter cannot resolve → 403", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .patch("/v1/error-logs/some-id/resolve")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/error-logs/cleanup — cleanup old logs (Admin only)
// ---------------------------------------------------------------------------

describe("DELETE /v1/error-logs/cleanup — cleanup (Admin only)", () => {
  it("Admin triggers cleanup → 200", async () => {
    const { token } = await createAdmin();

    // Create some resolved old logs
    const oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // 90 days ago
    await createErrorLog({ resolved: true, timestamp: oldDate });

    const res = await request(app)
      .delete("/v1/error-logs/cleanup")
      .set("Authorization", `Bearer ${token}`)
      .send({ daysToKeep: 30 });

    expect(res.status).toBe(200);
  });

  it("Recruiter cannot cleanup → 403", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .delete("/v1/error-logs/cleanup")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
