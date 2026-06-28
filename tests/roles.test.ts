/**
 * Role CRUD tests — create, list, get single, get questions.
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import { startTestDatabase, stopTestDatabase, clearAllTables } from "./helpers/db.js";
import {
  createTalent,
  createRecruiter,
  createAdmin,
  createRole,
  createQuestion,
} from "./helpers/fixtures.js";
import { QuestionType } from "../src/types/enums.js";

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
// POST /v1/roles/ — create role (Recruiter/Admin)
// ---------------------------------------------------------------------------

describe("POST /v1/roles/ — create role", () => {
  it("Recruiter creates a role → 201", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/roles/")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Software Engineer", description: "Backend dev role" });
    expect(res.status).toBe(201);
    expect(res.body.data.role.name).toBe("software engineer");
  });

  it("Admin creates a role → 201", async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .post("/v1/roles/")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Data Scientist" });
    expect(res.status).toBe(201);
  });

  it("Duplicate name → 409", async () => {
    const { token } = await createRecruiter();
    await createRole("frontend-dev");

    const res = await request(app)
      .post("/v1/roles/")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "frontend-dev" });

    expect(res.status).toBe(409);
  });

  it("Talent cannot create role → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/roles/")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "some-role" });
    expect(res.status).toBe(403);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app).post("/v1/roles/").send({ name: "role" });
    expect(res.status).toBe(401);
  });

  it("Missing name → 400", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/roles/")
      .set("Authorization", `Bearer ${token}`)
      .send({ description: "no name" });
    expect(res.status).toBe(400);
  });

  it("Role name is lowercased on save", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/roles/")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "UPPERCASE ROLE" });
    expect(res.status).toBe(201);
    expect(res.body.data.role.name).toBe("uppercase role");
  });
});

// ---------------------------------------------------------------------------
// GET /v1/roles/ — list roles (public)
// ---------------------------------------------------------------------------

describe("GET /v1/roles/ — list roles", () => {
  it("Returns paginated roles → 200 (public)", async () => {
    await createRole("role-a");
    await createRole("role-b");

    const res = await request(app).get("/v1/roles/");
    expect(res.status).toBe(200);
    const roles = res.body.data.roles ?? res.body.data ?? [];
    expect(Array.isArray(roles)).toBe(true);
    expect(roles.length).toBeGreaterThanOrEqual(2);
  });

  it("Unauthenticated can access", async () => {
    const res = await request(app).get("/v1/roles/");
    expect(res.status).toBe(200);
  });

  it("Pagination: limit reduces result count", async () => {
    for (let i = 0; i < 5; i++) await createRole(`pag-role-${i}`);

    const res = await request(app).get("/v1/roles/").query({ limit: 2, offset: 0 });
    expect(res.status).toBe(200);
    const roles = res.body.data.roles ?? res.body.data ?? [];
    expect(roles.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/roles/:_id — get single role
// ---------------------------------------------------------------------------

describe("GET /v1/roles/:_id — get single role", () => {
  it("Returns role by ID → 200", async () => {
    const role = await createRole("my-role");
    const res = await request(app).get(`/v1/roles/${role.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.role.name).toBe("my-role");
  });

  it("Non-existent ID → 404", async () => {
    const res = await request(app).get("/v1/roles/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/roles/:_id/questions — role questions
// ---------------------------------------------------------------------------

describe("GET /v1/roles/:_id/questions", () => {
  it("Returns prescreening questions for the role → 200", async () => {
    const role = await createRole();
    await createQuestion(QuestionType.Prescreening, { roleId: role.id });

    const res = await request(app).get(`/v1/roles/${role.id}/questions`);
    expect(res.status).toBe(200);
    const questions = res.body.data.questions ?? res.body.data ?? [];
    expect(Array.isArray(questions)).toBe(true);
    expect(questions.length).toBeGreaterThanOrEqual(1);
  });

  it("Role not found → 404", async () => {
    const res = await request(app).get("/v1/roles/00000000-0000-0000-0000-000000000000/questions");
    expect(res.status).toBe(404);
  });

  it("Empty list when no questions exist for role → 200 with empty array", async () => {
    const role = await createRole("empty-role");
    const res = await request(app).get(`/v1/roles/${role.id}/questions`);
    expect(res.status).toBe(200);
    const questions = res.body.data.questions ?? res.body.data ?? [];
    expect(questions.length).toBe(0);
  });
});
