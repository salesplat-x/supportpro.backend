/**
 * Error log tests — Superadmin-only access.
 * Documents ISSUE-008 (no registration path for Superadmin).
 *
 * Superadmin users are created directly via testDataSource since there is
 * no registration API route for them (ISSUE-008).
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import { startTestDatabase, stopTestDatabase, clearAllTables, testDataSource } from "./helpers/db.js";
import { createTalent, createRecruiter, createAdmin, createSuperadmin, createErrorLog } from "./helpers/fixtures.js";
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
// ISSUE-008: No Superadmin registration path
// ---------------------------------------------------------------------------

describe("ISSUE-008: No Superadmin registration path", () => {
  it("ISSUE-011 CRITICAL: POST /v1/auth/register accepts userRole in body → attacker can self-register as Superadmin", async () => {
    const res = await request(app).post("/v1/auth/register").send({
      email: "trysuperadmin@example.com",
      firstName: "A",
      lastName: "B",
      password: "Password1!",
      userRole: "superadmin", // attempting to self-register as superadmin
    });
    expect(res.status).toBe(201);
    // BUG (ISSUE-011): the user IS created as superadmin — userRole is accepted from req.body
    // This should be 201 with userRole: "talent" (role hardcoded by route, not from body)
    // When ISSUE-011 is fixed, change this to: expect(res.body.data.user.userRole).toBe("talent")
    expect(res.body.data.user.userRole).toBe("superadmin"); // Documents the vulnerability
  });

  it("There is no POST /v1/auth/register/superadmin route → 404", async () => {
    const res = await request(app).post("/v1/auth/register/superadmin").send({
      email: "sa@example.com",
      firstName: "SA",
      lastName: "User",
      password: "Password1!",
    });
    // Route does not exist → 404
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/error-logs/ — list error logs (Superadmin only)
// ---------------------------------------------------------------------------

describe("GET /v1/error-logs/ — list error logs (Superadmin only)", () => {
  it("Superadmin fetches error logs → 200", async () => {
    const { token } = await createSuperadmin();
    await createErrorLog({ message: "Test error 1" });
    await createErrorLog({ message: "Test error 2" });

    const res = await request(app)
      .get("/v1/error-logs/")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const logs = res.body.data.logs ?? res.body.data ?? [];
    expect(Array.isArray(logs)).toBe(true);
  });

  it("Admin cannot access error logs → 403", async () => {
    const { token } = await createAdmin();
    const res = await request(app).get("/v1/error-logs/").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
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
    const { token } = await createSuperadmin();
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
    const { token } = await createSuperadmin();
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
// GET /v1/error-logs/stats — stats (Superadmin only)
// ---------------------------------------------------------------------------

describe("GET /v1/error-logs/stats — stats (Superadmin only)", () => {
  it("Superadmin gets stats → 200", async () => {
    const { token } = await createSuperadmin();
    await createErrorLog({ resolved: false });
    await createErrorLog({ resolved: true });

    const res = await request(app)
      .get("/v1/error-logs/stats")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });

  it("Admin cannot access stats → 403", async () => {
    const { token } = await createAdmin();
    const res = await request(app).get("/v1/error-logs/stats").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/error-logs/:requestId/resolve — mark resolved (Superadmin only)
// ---------------------------------------------------------------------------

describe("PATCH /v1/error-logs/:requestId/resolve — mark resolved", () => {
  it("Superadmin marks an error log as resolved → 200", async () => {
    const { token } = await createSuperadmin();
    const log = await createErrorLog({ requestId: "REQ-001", resolved: false });

    const res = await request(app)
      .patch(`/v1/error-logs/${log.requestId ?? "REQ-001"}/resolve`)
      .set("Authorization", `Bearer ${token}`)
      .send({ resolvedBy: "superadmin" });

    expect(res.status).toBe(200);
  });

  it("Admin cannot resolve → 403", async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .patch("/v1/error-logs/some-id/resolve")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/error-logs/cleanup — cleanup old logs (Superadmin only)
// ---------------------------------------------------------------------------

describe("DELETE /v1/error-logs/cleanup — cleanup (Superadmin only)", () => {
  it("Superadmin triggers cleanup → 200", async () => {
    const { token } = await createSuperadmin();

    // Create some resolved old logs
    const oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // 90 days ago
    await createErrorLog({ resolved: true, timestamp: oldDate });

    const res = await request(app)
      .delete("/v1/error-logs/cleanup")
      .set("Authorization", `Bearer ${token}`)
      .send({ daysToKeep: 30 });

    expect(res.status).toBe(200);
  });

  it("Admin cannot cleanup → 403", async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .delete("/v1/error-logs/cleanup")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
