/**
 * Organization tests — recruiter-owned creation/switching, admin verification.
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import { startTestDatabase, stopTestDatabase, clearAllTables } from "./helpers/db.js";
import {
  createTalent,
  createRecruiter,
  createAdmin,
  createOrganization,
} from "./helpers/fixtures.js";

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
// POST /v1/organizations/ — create organization (Recruiter only)
// ---------------------------------------------------------------------------

describe("POST /v1/organizations/ — create organization (Recruiter only)", () => {
  it("Recruiter creates organization → 201, pending, and becomes their active company", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send(validOrgBody);
    expect(res.status).toBe(201);
    expect(res.body.data.organization.name).toBe("TechCorp Ltd");
    expect(res.body.data.organization.status).toBe("pending");
  });

  it("Admin cannot create organization → 403", async () => {
    const { token } = await createAdmin();
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
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "org@test.com" });
    expect(res.status).toBe(400);
  });

  it("Invalid email format → 400", async () => {
    const { token } = await createRecruiter();
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...validOrgBody, email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("Missing both website and LinkedIn → 400", async () => {
    const { token } = await createRecruiter();
    const { website: _website, ...bodyWithoutWebsite } = validOrgBody;
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send(bodyWithoutWebsite);
    expect(res.status).toBe(400);
  });

  it("LinkedIn provided without a website → 201", async () => {
    const { token } = await createRecruiter();
    const { website: _website, ...bodyWithoutWebsite } = validOrgBody;
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...bodyWithoutWebsite, linkedin: "https://linkedin.com/company/techcorp" });
    expect(res.status).toBe(201);
  });

  it("Second company created by the same recruiter switches their active company", async () => {
    const { token } = await createRecruiter();
    const first = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send(validOrgBody);
    const second = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        ...validOrgBody,
        name: "Second Co",
        email: "contact@secondco.com",
        phone: "+2348098765432",
      });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const me = await request(app).get("/v1/user/me").set("Authorization", `Bearer ${token}`);
    expect(me.body.data.user.activeOrganizationId).toBe(second.body.data.organization.id);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/organizations/me — recruiter's own companies
// ---------------------------------------------------------------------------

describe("GET /v1/organizations/me", () => {
  it("lists only companies owned by the requesting recruiter", async () => {
    const { user: recruiterA, token: tokenA } = await createRecruiter();
    const { user: recruiterB } = await createRecruiter();
    await createOrganization(recruiterA, { name: "A Co" });
    await createOrganization(recruiterB, { name: "B Co" });

    const res = await request(app)
      .get("/v1/organizations/me")
      .set("Authorization", `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.data.organizations).toHaveLength(1);
    expect(res.body.data.organizations[0].name).toBe("A Co");
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/organizations/:_id/switch
// ---------------------------------------------------------------------------

describe("PATCH /v1/organizations/:_id/switch", () => {
  it("switches the recruiter's active company", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const orgA = await createOrganization(recruiter, { name: "A Co" });
    const orgB = await createOrganization(recruiter, { name: "B Co" });

    const res = await request(app)
      .patch(`/v1/organizations/${orgA.id}/switch`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const me = await request(app).get("/v1/user/me").set("Authorization", `Bearer ${token}`);
    expect(me.body.data.user.activeOrganizationId).toBe(orgA.id);
    expect(orgB.id).not.toBe(orgA.id);
  });

  it("cannot switch to a company owned by another recruiter → 403", async () => {
    const { user: recruiterA } = await createRecruiter();
    const { token: tokenB } = await createRecruiter();
    const orgA = await createOrganization(recruiterA);

    const res = await request(app)
      .patch(`/v1/organizations/${orgA.id}/switch`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Admin verification — GET /v1/admin/organizations, verify/reject
// ---------------------------------------------------------------------------

describe("Admin organization verification", () => {
  it("Admin lists organizations, verifies one, rejects another", async () => {
    const { user: recruiter } = await createRecruiter();
    const { token: adminToken } = await createAdmin();
    const orgA = await createOrganization(recruiter, { name: "A Co" });
    const orgB = await createOrganization(recruiter, { name: "B Co" });

    const list = await request(app)
      .get("/v1/admin/organizations")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.total).toBe(2);

    const verify = await request(app)
      .patch(`/v1/admin/organizations/${orgA.id}/verify`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(verify.status).toBe(200);
    expect(verify.body.data.organization.status).toBe("verified");

    const reject = await request(app)
      .patch(`/v1/admin/organizations/${orgB.id}/reject`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(reject.status).toBe(200);
    expect(reject.body.data.organization.status).toBe("rejected");
  });

  it("Recruiter cannot access admin organization endpoints → 403", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const org = await createOrganization(recruiter);

    const list = await request(app)
      .get("/v1/admin/organizations")
      .set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(403);

    const verify = await request(app)
      .patch(`/v1/admin/organizations/${org.id}/verify`)
      .set("Authorization", `Bearer ${token}`);
    expect(verify.status).toBe(403);
  });
});
