/**
 * Organization tests — Admin-only creation, duplicate detection.
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import { startTestDatabase, stopTestDatabase, clearAllTables } from "./helpers/db.js";
import { createTalent, createRecruiter, createAdmin } from "./helpers/fixtures.js";

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

const validOrgBody = {
  name: "TechCorp Ltd",
  email: "contact@techcorp.com",
  phone: "+2348012345678",
  address: "123 Tech Street, Lagos",
  industry: "Technology",
  website: "https://techcorp.com",
};

// ---------------------------------------------------------------------------
// POST /v1/organizations/ — create organization (Admin only)
// ---------------------------------------------------------------------------

describe("POST /v1/organizations/ — create organization (Admin only)", () => {
  it("Admin creates organization → 201", async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send(validOrgBody);
    expect(res.status).toBe(201);
    expect(res.body.data.organization.name).toBe("TechCorp Ltd");
  });

  it("Recruiter cannot create organization → 403", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send(validOrgBody);
    expect(res.status).toBe(403);
  });

  it("Talent cannot create organization → 403", async () => {
    const { token } = await createTalent();
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send(validOrgBody);
    expect(res.status).toBe(403);
  });

  it("Unauthenticated → 401", async () => {
    const res = await request(app).post("/v1/organizations/").send(validOrgBody);
    expect(res.status).toBe(401);
  });

  it("Missing name → 400", async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "org@test.com" });
    expect(res.status).toBe(400);
  });

  it("Invalid email format → 400", async () => {
    const { token } = await createAdmin();
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...validOrgBody, email: "not-an-email" });
    expect(res.status).toBe(400);
  });
});
