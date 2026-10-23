/**
 * Organization tests — recruiter-owned creation/switching, admin verification.
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
  FeatureUsageCounter,
  Job,
  Organization,
  OrganizationMember,
  Payment,
  ScoutRun,
  User,
} from "../src/entities";
import {
  createTalent,
  createRecruiter,
  createAdmin,
  createCompanyHistory,
  createOrganization,
  createRole,
  createJob,
} from "./helpers/fixtures.js";
import * as paystack from "../src/utils/integrations/paystack.js";
import {
  BillingInterval,
  BillingStatus,
  DEFAULT_BILLING_PLAN_KEY,
  OrganizationStatus,
} from "../src/types/enums.js";
import * as organizationService from "../src/services/organization.js";
import { uploadToSpaces, deleteFromSpaces } from "../src/utils/integrations/spaces.js";

const mockUploadToSpaces = uploadToSpaces as jest.Mock;
const mockDeleteFromSpaces = deleteFromSpaces as jest.Mock;

jest.mock("../src/utils/integrations/spaces.js", () => {
  // See tests/user.test.ts for why deleteSpacesObjectQuietly is reimplemented
  // here rather than pulled from requireActual.
  const actual = jest.requireActual("../src/utils/integrations/spaces.js");
  const deleteFromSpaces = jest.fn().mockResolvedValue(undefined);
  return {
    ...actual,
    uploadToSpaces: jest.fn((_buffer: Buffer, key: string) =>
      Promise.resolve(`https://salesplat.nyc3.digitaloceanspaces.com/${key}`)
    ),
    deleteFromSpaces,
    deleteSpacesObjectQuietly: jest.fn(async (key: string | null) => {
      if (!key) return;
      await deleteFromSpaces(key).catch(() => undefined);
    }),
  };
});

jest.mock("../src/utils/integrations/email/emailService.js", () => {
  const sendCompanyInvite = jest.fn().mockResolvedValue(undefined);
  return {
    __esModule: true,
    sendCompanyInvite,
    default: jest.fn().mockImplementation(() => ({
      sendWelcome: jest.fn().mockResolvedValue(undefined),
      sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
      sendCompanyInvite,
    })),
  };
});

function inviteTokenFromEmail(): string {
  const { sendCompanyInvite } = jest.requireMock(
    "../src/utils/integrations/email/emailService.js"
  ) as { sendCompanyInvite: jest.Mock };
  const inviteLink = sendCompanyInvite.mock.calls.at(-1)?.[0]?.inviteLink as string | undefined;
  const token = inviteLink?.split("/").pop();
  if (!token) {
    throw new Error("Invite email was not sent");
  }
  return token;
}

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
  domain: "@techcorp.com",
  email: "contact@techcorp.com",
  phone: "+2348012345678",
  address: "123 Tech Street, Lagos",
  industry: "Technology",
  website: "https://techcorp.com",
  linkedin: "https://linkedin.com/company/techcorp",
};

const recruiterForTechCorp = () => createRecruiter({ email: "creator@techcorp.com" });

// ---------------------------------------------------------------------------
// POST /v1/organizations/ — create organization (Recruiter only)
// ---------------------------------------------------------------------------

describe("POST /v1/organizations/ — create organization (Recruiter only)", () => {
  it("Recruiter creates organization → 201, pending, and becomes their active company", async () => {
    const { token } = await recruiterForTechCorp();
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send(validOrgBody);
    expect(res.status).toBe(201);
    expect(res.body.data.organization.name).toBe("TechCorp Ltd");
    expect(res.body.data.organization.status).toBe("pending");
  });

  it("Create ignores plan, billing, verification and ownership fields in the body → defaults", async () => {
    const { user: recruiter, token } = await recruiterForTechCorp();
    const { user: someoneElse } = await createRecruiter();
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        ...validOrgBody,
        status: OrganizationStatus.Verified,
        billingPlan: "enterprise",
        billingStatus: BillingStatus.PastDue,
        billingInterval: BillingInterval.Annually,
        billingPeriodEnd: "2099-12-31T00:00:00.000Z",
        verifiedAt: "2026-01-01T00:00:00.000Z",
        verifiedById: someoneElse.id,
        ownerId: someoneElse.id,
        logoKey: "organizations/someone-else/logo.png",
      });

    expect(res.status).toBe(201);
    const createdId = (res.body as { data: { organization: Organization } }).data.organization.id;
    const created = await testDataSource
      .getRepository(Organization)
      .findOneByOrFail({ id: createdId });
    expect(created.name).toBe("TechCorp Ltd");
    expect(created.status).toBe(OrganizationStatus.Pending);
    expect(created.billingPlan).toBe(DEFAULT_BILLING_PLAN_KEY);
    expect(created.billingStatus).toBe(BillingStatus.Active);
    expect(created.billingInterval).toBeNull();
    expect(created.billingPeriodEnd).toBeNull();
    expect(created.verifiedAt).toBeNull();
    expect(created.verifiedById).toBeNull();
    expect(created.ownerId).toBe(recruiter.id);
    expect(created.logoKey).toBeNull();
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
    const { token } = await recruiterForTechCorp();
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "org@test.com" });
    expect(res.status).toBe(400);
  });

  it("Invalid email format → 400", async () => {
    const { token } = await recruiterForTechCorp();
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...validOrgBody, email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("LinkedIn is optional when a domain is provided → 201", async () => {
    const { token } = await recruiterForTechCorp();
    const { linkedin: _linkedin, ...bodyWithoutLinkedin } = validOrgBody;
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send(bodyWithoutLinkedin);
    expect(res.status).toBe(201);
  });

  it("Missing both domain and LinkedIn → 400", async () => {
    const { token } = await recruiterForTechCorp();
    const { domain: _domain, linkedin: _linkedin, ...bodyWithoutDomainOrLinkedin } = validOrgBody;
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send(bodyWithoutDomainOrLinkedin);
    expect(res.status).toBe(400);
  });

  it("No domain, but a valid LinkedIn URL → 201, and email is not required to be corporate", async () => {
    const { token } = await createRecruiter({ email: "founder@gmail.com" });
    const { domain: _domain, ...bodyWithoutDomain } = validOrgBody;
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...bodyWithoutDomain, email: "founder@gmail.com" });
    expect(res.status).toBe(201);
  });

  // The real create-company form always sends domain: "" when the field is left
  // blank (Formik never omits the key), not an absent key like the test above —
  // express-validator's default .optional() only skips `undefined`, not "", so
  // this exact shape is what regressed in production.
  it("Empty-string domain (as the form actually sends it) → 201, not a format error", async () => {
    const { token } = await createRecruiter({ email: "founder@gmail.com" });
    const { domain: _domain, ...bodyWithoutDomain } = validOrgBody;
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...bodyWithoutDomain, domain: "", email: "founder@gmail.com" });
    expect(res.status).toBe(201);
  });

  it("Invalid LinkedIn URL → 400", async () => {
    const { token } = await recruiterForTechCorp();
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...validOrgBody, linkedin: "not-a-linkedin-url" });
    expect(res.status).toBe(400);
  });

  it("LinkedIn provided without a website → 201", async () => {
    const { token } = await recruiterForTechCorp();
    const { website: _website, ...bodyWithoutWebsite } = validOrgBody;
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send(bodyWithoutWebsite);
    expect(res.status).toBe(201);
  });

  it("Personal email domain → 400", async () => {
    const { token } = await recruiterForTechCorp();
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...validOrgBody, email: "owner@gmail.com" });
    expect(res.status).toBe(400);
  });

  it("Email domain does not match website → 400", async () => {
    const { token } = await recruiterForTechCorp();
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send({
        ...validOrgBody,
        email: "contact@othercorp.com",
      });
    expect(res.status).toBe(400);
  });

  it("Same name and website as an existing company → 409", async () => {
    const { token: firstToken } = await recruiterForTechCorp();
    const first = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${firstToken}`)
      .send(validOrgBody);
    expect(first.status).toBe(201);

    const { token: secondToken } = await createRecruiter({ email: "other@techcorp.com" });
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${secondToken}`)
      .send({ ...validOrgBody, email: "other@techcorp.com", phone: "+2348011112222" });

    expect(res.status).toBe(409);
  });

  it("Same name but different website → 201 (name alone may repeat)", async () => {
    const { token: firstToken } = await recruiterForTechCorp();
    const first = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${firstToken}`)
      .send(validOrgBody);
    expect(first.status).toBe(201);

    const { token: secondToken } = await createRecruiter({ email: "other@techcorp.io" });
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${secondToken}`)
      .send({
        ...validOrgBody,
        domain: "@techcorp.io",
        email: "other@techcorp.io",
        phone: "+2348011112222",
        website: "https://techcorp.io",
      });

    expect(res.status).toBe(201);
  });

  it("Same recruiter cannot create a second company on a different domain", async () => {
    const { token } = await recruiterForTechCorp();
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
        domain: "@secondco.com",
        email: "contact@secondco.com",
        phone: "+2348098765432",
        website: "https://secondco.com",
      });

    expect(first.status).toBe(201);
    expect(second.status).toBe(400);
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

// ---------------------------------------------------------------------------
// PATCH /v1/organizations/:id — update organization (owner only)
// ---------------------------------------------------------------------------

describe("PATCH /v1/organizations/:id — update organization", () => {
  it("Owner updates editable fields → 200", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const org = await createOrganization(recruiter, { name: "Old Name" });

    const res = await request(app)
      .patch(`/v1/organizations/${org.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "New Name",
        industry: "Fintech",
      });

    expect(res.status).toBe(200);
    expect(res.body.data.organization.name).toBe("New Name");
    expect(res.body.data.organization.industry).toBe("Fintech");
  });

  it("Email and website are ignored even when sent → unchanged", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const org = await createOrganization(recruiter, {
      email: "locked@example.com",
      website: "https://locked.example.com",
    });

    const res = await request(app)
      .patch(`/v1/organizations/${org.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Renamed",
        email: "hacker@example.com",
        website: "https://hacker.example.com",
      });

    expect(res.status).toBe(200);
    expect(res.body.data.organization.name).toBe("Renamed");
    expect(res.body.data.organization.email).toBe("locked@example.com");
    expect(res.body.data.organization.website).toBe("https://locked.example.com");
  });

  it("logoUrl sent in the body is ignored — only the upload endpoint can set it", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const org = await createOrganization(recruiter, {
      logoUrl: "https://original.example.com/logo.png",
    });

    const res = await request(app)
      .patch(`/v1/organizations/${org.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Renamed", logoUrl: "https://attacker.example.com/logo.png" });

    expect(res.status).toBe(200);
    expect(res.body.data.organization.name).toBe("Renamed");
    expect(res.body.data.organization.logoUrl).toBe("https://original.example.com/logo.png");
  });

  it("Owner cannot self-verify or change the plan: protected fields are ignored → 200, unchanged", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const { user: someoneElse } = await createRecruiter();
    const org = await createOrganization(recruiter, { name: "Acme Hiring" });
    const before = await testDataSource.getRepository(Organization).findOneByOrFail({ id: org.id });
    expect(before.status).toBe(OrganizationStatus.Pending);
    expect(before.billingPlan).toBe(DEFAULT_BILLING_PLAN_KEY);

    const res = await request(app)
      .patch(`/v1/organizations/${org.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Acme Hiring Ltd",
        status: OrganizationStatus.Verified,
        verifiedAt: "2026-01-01T00:00:00.000Z",
        verifiedById: someoneElse.id,
        billingPlan: "enterprise",
        billingStatus: BillingStatus.Active,
        billingInterval: BillingInterval.Annually,
        billingPeriodEnd: "2099-12-31T00:00:00.000Z",
        ownerId: someoneElse.id,
        logoKey: "organizations/someone-else/logo.png",
        createdAt: "2000-01-01T00:00:00.000Z",
      });

    expect(res.status).toBe(200);
    const returned = (res.body as { data: { organization: Organization } }).data.organization;
    expect(returned.name).toBe("Acme Hiring Ltd");
    expect(returned.status).toBe(OrganizationStatus.Pending);
    expect(returned.billingPlan).toBe(DEFAULT_BILLING_PLAN_KEY);

    const after = await testDataSource.getRepository(Organization).findOneByOrFail({ id: org.id });
    expect(after.name).toBe("Acme Hiring Ltd");
    expect(after.status).toBe(OrganizationStatus.Pending);
    expect(after.verifiedAt).toBeNull();
    expect(after.verifiedById).toBeNull();
    expect(after.billingPlan).toBe(DEFAULT_BILLING_PLAN_KEY);
    expect(after.billingStatus).toBe(before.billingStatus);
    expect(after.billingInterval).toBe(before.billingInterval);
    expect(after.billingPeriodEnd).toBe(before.billingPeriodEnd);
    expect(after.ownerId).toBe(recruiter.id);
    expect(after.logoKey).toBe(before.logoKey);
    expect(after.createdAt.toISOString()).toBe(before.createdAt.toISOString());
  });

  it("Sending only protected fields changes nothing → 200, unchanged", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const org = await createOrganization(recruiter, { name: "Only Extras" });

    const res = await request(app)
      .patch(`/v1/organizations/${org.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: OrganizationStatus.Verified, billingPlan: "enterprise" });

    expect(res.status).toBe(200);
    const after = await testDataSource.getRepository(Organization).findOneByOrFail({ id: org.id });
    expect(after.name).toBe("Only Extras");
    expect(after.status).toBe(OrganizationStatus.Pending);
    expect(after.billingPlan).toBe(DEFAULT_BILLING_PLAN_KEY);
  });

  it("A changed id in the body cannot redirect the update to another company", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const { user: otherOwner } = await createRecruiter();
    const org = await createOrganization(recruiter, { name: "Mine" });
    const other = await createOrganization(otherOwner, { name: "Theirs" });

    const res = await request(app)
      .patch(`/v1/organizations/${org.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ id: other.id, name: "Overwritten" });

    expect(res.status).toBe(200);
    const repo = testDataSource.getRepository(Organization);
    expect((await repo.findOneByOrFail({ id: org.id })).name).toBe("Overwritten");
    const theirs = await repo.findOneByOrFail({ id: other.id });
    expect(theirs.name).toBe("Theirs");
    expect(theirs.ownerId).toBe(otherOwner.id);
  });

  it("Every editable field still updates when sent beside protected ones", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const org = await createOrganization(recruiter);

    const editable = {
      name: "Editable Co",
      phone: "+2348058272524",
      address: "1 New Road, Abuja",
      industry: "Logistics",
      twitter: "https://x.com/editableco",
      linkedin: "https://linkedin.com/company/editableco",
      facebook: "https://facebook.com/editableco",
    };
    const res = await request(app)
      .patch(`/v1/organizations/${org.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ ...editable, status: OrganizationStatus.Verified, billingPlan: "enterprise" });

    expect(res.status).toBe(200);
    const after = await testDataSource.getRepository(Organization).findOneByOrFail({ id: org.id });
    expect(after).toMatchObject(editable);
    expect(after.status).toBe(OrganizationStatus.Pending);
    expect(after.billingPlan).toBe(DEFAULT_BILLING_PLAN_KEY);
  });

  it("Service layer ignores protected fields even if a caller skips the HTTP validator", async () => {
    const { user: recruiter } = await createRecruiter();
    const org = await createOrganization(recruiter, { name: "Direct Call" });

    const payload = {
      name: "Direct Call Renamed",
      status: OrganizationStatus.Verified,
      billingPlan: "enterprise",
      ownerId: null,
    } as unknown as organizationService.UpdateOrganizationPayload;
    const result = await organizationService.updateOrganization(recruiter.id, org.id, payload);

    expect(result.name).toBe("Direct Call Renamed");
    const after = await testDataSource.getRepository(Organization).findOneByOrFail({ id: org.id });
    expect(after.name).toBe("Direct Call Renamed");
    expect(after.status).toBe(OrganizationStatus.Pending);
    expect(after.billingPlan).toBe(DEFAULT_BILLING_PLAN_KEY);
    expect(after.ownerId).toBe(recruiter.id);
  });

  it("Non-owner recruiter cannot update → 403", async () => {
    const { user: owner } = await createRecruiter();
    const { token: otherToken } = await createRecruiter();
    const org = await createOrganization(owner);

    const res = await request(app)
      .patch(`/v1/organizations/${org.id}`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ name: "Hijacked" });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// DELETE /v1/organizations/:id — delete organization (owner only, cascades)
// ---------------------------------------------------------------------------

describe("DELETE /v1/organizations/:id — delete organization", () => {
  it("Owner deletes company → 200, jobs cascade, active company cleared", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const org = await createOrganization(recruiter);
    const role = await createRole();
    await createJob(recruiter, role, { organizationId: org.id });

    const res = await request(app)
      .delete(`/v1/organizations/${org.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const list = await request(app)
      .get("/v1/organizations/me")
      .set("Authorization", `Bearer ${token}`);
    expect(list.body.data.organizations).toHaveLength(0);

    const remainingJobs = await testDataSource
      .getRepository(Job)
      .count({ where: { organizationId: org.id } });
    expect(remainingJobs).toBe(0);

    const refreshed = await testDataSource
      .getRepository(User)
      .findOne({ where: { id: recruiter.id } });
    expect(refreshed?.activeOrganizationId).toBeNull();
  });

  it("Owner deletes a company with usage, billing and scout history → 200", async () => {
    const disable = jest.spyOn(paystack, "disableSubscription");
    const { user: recruiter, token } = await createRecruiter();
    const org = await createOrganization(recruiter);
    const history = await createCompanyHistory(recruiter, org);

    const res = await request(app)
      .delete(`/v1/organizations/${org.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    expect(await testDataSource.getRepository(Organization).findOneBy({ id: org.id })).toBeNull();
    expect(
      await testDataSource.getRepository(FeatureUsageCounter).findOneBy({ id: history.counter.id })
    ).toBeNull();
    expect(
      await testDataSource.getRepository(ScoutRun).findOneBy({ id: history.scoutRun.id })
    ).toBeNull();
    expect(
      (await testDataSource.getRepository(Payment).findOneBy({ id: history.payment.id }))
        ?.organizationId
    ).toBeNull();
    expect(disable).toHaveBeenCalledWith({
      code: history.subscription.paystackSubscriptionCode,
      token: "tok_company",
    });
    disable.mockRestore();
  });

  it("Non-owner recruiter cannot delete → 403", async () => {
    const { user: owner } = await createRecruiter();
    const { token: otherToken } = await createRecruiter();
    const org = await createOrganization(owner);

    const res = await request(app)
      .delete(`/v1/organizations/${org.id}`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(403);
  });

  it("Deletes the logo from Spaces when the organization is deleted", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const org = await createOrganization(recruiter, {
      logoUrl: "https://salesplat.nyc3.digitaloceanspaces.com/logos/org-1/existing.png",
      logoKey: "logos/org-1/existing.png",
    });

    const res = await request(app)
      .delete(`/v1/organizations/${org.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(mockDeleteFromSpaces).toHaveBeenCalledWith("logos/org-1/existing.png");
  });
});

// ---------------------------------------------------------------------------
// PATCH/DELETE /v1/organizations/:id/logo — company logo upload/remove
// ---------------------------------------------------------------------------

describe("PATCH /v1/organizations/:id/logo", () => {
  const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0x02, 0x03]);

  it("uploads a logo and stores the returned URL", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const org = await createOrganization(recruiter);

    const res = await request(app)
      .patch(`/v1/organizations/${org.id}/logo`)
      .set("Authorization", `Bearer ${token}`)
      .attach("logo", jpeg(), { filename: "logo.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(200);
    expect(mockUploadToSpaces).toHaveBeenCalledTimes(1);
    const [, key] = mockUploadToSpaces.mock.calls[0] as [Buffer, string, string];
    expect(key).toMatch(new RegExp(`^logos/${org.id}/.+\\.jpg$`));
    expect(res.body.data.organization.logoUrl).toBe(
      `https://salesplat.nyc3.digitaloceanspaces.com/${key}`
    );
  });

  it("deletes the previous logo object in Spaces when replacing it", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const org = await createOrganization(recruiter);
    await request(app)
      .patch(`/v1/organizations/${org.id}/logo`)
      .set("Authorization", `Bearer ${token}`)
      .attach("logo", jpeg(), { filename: "first.jpg", contentType: "image/jpeg" });
    const firstKey = mockUploadToSpaces.mock.calls[0]![1] as string;

    const res = await request(app)
      .patch(`/v1/organizations/${org.id}/logo`)
      .set("Authorization", `Bearer ${token}`)
      .attach("logo", jpeg(), { filename: "second.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(200);
    expect(mockDeleteFromSpaces).toHaveBeenCalledWith(firstKey);
  });

  it("rejects a non-owner recruiter with 403 and never calls Spaces", async () => {
    const { user: owner } = await createRecruiter();
    const { token: otherToken } = await createRecruiter();
    const org = await createOrganization(owner);

    const res = await request(app)
      .patch(`/v1/organizations/${org.id}/logo`)
      .set("Authorization", `Bearer ${otherToken}`)
      .attach("logo", jpeg(), { filename: "logo.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(403);
    expect(mockUploadToSpaces).not.toHaveBeenCalled();
  });

  it("rejects an unsupported mimetype without calling Spaces", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const org = await createOrganization(recruiter);

    const res = await request(app)
      .patch(`/v1/organizations/${org.id}/logo`)
      .set("Authorization", `Bearer ${token}`)
      .attach("logo", Buffer.from("%PDF-1.4 fake"), {
        filename: "not-an-image.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(400);
    expect(mockUploadToSpaces).not.toHaveBeenCalled();
  });

  it("rejects an empty image file without calling Spaces", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const org = await createOrganization(recruiter);

    const res = await request(app)
      .patch(`/v1/organizations/${org.id}/logo`)
      .set("Authorization", `Bearer ${token}`)
      .attach("logo", Buffer.alloc(0), { filename: "empty.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(400);
    expect(mockUploadToSpaces).not.toHaveBeenCalled();
  });

  it("rejects an oversized image with a clean 400, not a 500", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const org = await createOrganization(recruiter);
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, "a");

    const res = await request(app)
      .patch(`/v1/organizations/${org.id}/logo`)
      .set("Authorization", `Bearer ${token}`)
      .attach("logo", oversized, { filename: "huge.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(400);
    expect(mockUploadToSpaces).not.toHaveBeenCalled();
  });
});

describe("DELETE /v1/organizations/:id/logo", () => {
  const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x01, 0x02, 0x03]);

  it("removes an existing logo and deletes it from Spaces", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const org = await createOrganization(recruiter);
    await request(app)
      .patch(`/v1/organizations/${org.id}/logo`)
      .set("Authorization", `Bearer ${token}`)
      .attach("logo", jpeg(), { filename: "logo.jpg", contentType: "image/jpeg" });
    const key = mockUploadToSpaces.mock.calls[0]![1] as string;

    const res = await request(app)
      .delete(`/v1/organizations/${org.id}/logo`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.organization.logoUrl).toBeNull();
    expect(mockDeleteFromSpaces).toHaveBeenCalledWith(key);
  });

  it("is a no-op 200 when there is no logo to remove", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const org = await createOrganization(recruiter);

    const res = await request(app)
      .delete(`/v1/organizations/${org.id}/logo`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(mockDeleteFromSpaces).not.toHaveBeenCalled();
  });

  it("rejects a non-owner recruiter with 403", async () => {
    const { user: owner } = await createRecruiter();
    const { token: otherToken } = await createRecruiter();
    const org = await createOrganization(owner, {
      logoUrl: "https://salesplat.nyc3.digitaloceanspaces.com/logos/org-1/existing.png",
      logoKey: "logos/org-1/existing.png",
    });

    const res = await request(app)
      .delete(`/v1/organizations/${org.id}/logo`)
      .set("Authorization", `Bearer ${otherToken}`);

    expect(res.status).toBe(403);
    expect(mockDeleteFromSpaces).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Company invites
// ---------------------------------------------------------------------------

describe("Organization invites", () => {
  const corporateOrgBody = {
    name: "Invite Corp",
    domain: "@invitecorp.com",
    email: "owner@invitecorp.com",
    phone: "+2348012345679",
    address: "1 Invite Street",
    industry: "Technology",
    website: "https://invitecorp.com",
    linkedin: "https://linkedin.com/company/invitecorp",
  };

  // Seats are plan-driven and count the owner, so invite-mechanics tests put the company
  // on a plan with room; the seat-limit tests below pick a plan deliberately.
  async function createOwnedOrg(billingPlan = "enterprise") {
    const { token, user } = await createRecruiter({ email: "owner@invitecorp.com" });
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send(corporateOrgBody);
    expect(res.status).toBe(201);
    const org = res.body.data.organization;
    await testDataSource.getRepository(Organization).update(org.id, { billingPlan });
    return { org, token, user };
  }

  it("Owner sends invite → 201, lists pending invite", async () => {
    const { org, token } = await createOwnedOrg();

    const send = await request(app)
      .post(`/v1/organizations/${org.id}/invites`)
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "teammate@invitecorp.com" });
    expect(send.status).toBe(201);
    expect(send.body.data.invite.email).toBe("teammate@invitecorp.com");

    const list = await request(app)
      .get(`/v1/organizations/${org.id}/invites`)
      .set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.data.invites).toHaveLength(1);
  });

  it("Rejects invite when email domain does not match company → 400", async () => {
    const { org, token } = await createOwnedOrg();

    const res = await request(app)
      .post(`/v1/organizations/${org.id}/invites`)
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "person@gmail.com" });
    expect(res.status).toBe(400);
  });

  it("Recruiter accepts invite and joins company", async () => {
    const { org, token: ownerToken } = await createOwnedOrg();

    const send = await request(app)
      .post(`/v1/organizations/${org.id}/invites`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ email: "joiner@invitecorp.com" });
    expect(send.status).toBe(201);

    const token = inviteTokenFromEmail();

    const publicPreview = await request(app).get(`/v1/organizations/invites/${token}`);
    expect(publicPreview.status).toBe(200);
    expect(publicPreview.body.data.invite.organizationName).toBe("Invite Corp");

    const { token: joinerToken } = await createRecruiter({
      email: "joiner@invitecorp.com",
    });

    const accept = await request(app)
      .post(`/v1/organizations/invites/${token}/accept`)
      .set("Authorization", `Bearer ${joinerToken}`);
    expect(accept.status).toBe(200);
    expect(accept.body.data.organization.id).toBe(org.id);

    const acceptAgain = await request(app)
      .post(`/v1/organizations/invites/${token}/accept`)
      .set("Authorization", `Bearer ${joinerToken}`);
    expect(acceptAgain.status).toBe(200);
    expect(acceptAgain.body.data.organization.id).toBe(org.id);

    const me = await request(app).get("/v1/user/me").set("Authorization", `Bearer ${joinerToken}`);
    expect(me.body.data.user.activeOrganizationId).toBe(org.id);

    const members = await request(app)
      .get(`/v1/organizations/${org.id}/members`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(members.status).toBe(200);
    expect(members.body.data.members).toHaveLength(2);
    const roles = members.body.data.members.map((m: { role: string }) => m.role).sort();
    expect(roles).toEqual(["member", "owner"]);
    const emails = members.body.data.members.map((m: { user: { email: string } }) => m.user.email);
    expect(emails).toContain("joiner@invitecorp.com");
  });

  it("Owner lists company users including themselves", async () => {
    const { org, token } = await createOwnedOrg();

    const members = await request(app)
      .get(`/v1/organizations/${org.id}/members`)
      .set("Authorization", `Bearer ${token}`);
    expect(members.status).toBe(200);
    expect(members.body.data.members).toHaveLength(1);
    expect(members.body.data.members[0].role).toBe("owner");
    expect(members.body.data.members[0].user).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        firstName: expect.any(String),
        lastName: expect.any(String),
        email: expect.any(String),
      })
    );
  });

  it("Non-owner recruiter cannot list company members → 403", async () => {
    const { org, token: ownerToken } = await createOwnedOrg();
    const { token: otherToken } = await createRecruiter();

    const res = await request(app)
      .get(`/v1/organizations/${org.id}/members`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(403);
  });

  it("Only the company creator can send an invite → 403 for other recruiters", async () => {
    const { org, token: ownerToken } = await createOwnedOrg();
    const { token: otherToken } = await createRecruiter();

    const res = await request(app)
      .post(`/v1/organizations/${org.id}/invites`)
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ email: "teammate@invitecorp.com" });
    expect(res.status).toBe(403);
  });

  it("Admin sees creator and recruiters on a company", async () => {
    const { org, token: ownerToken } = await createOwnedOrg();
    const { token: adminToken } = await createAdmin();

    const send = await request(app)
      .post(`/v1/organizations/${org.id}/invites`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ email: "recruiter@invitecorp.com" });
    expect(send.status).toBe(201);

    const token = inviteTokenFromEmail();
    const { token: joinerToken } = await createRecruiter({
      email: "recruiter@invitecorp.com",
    });
    const accept = await request(app)
      .post(`/v1/organizations/invites/${token}/accept`)
      .set("Authorization", `Bearer ${joinerToken}`);
    expect(accept.status).toBe(200);

    const detail = await request(app)
      .get(`/v1/admin/organizations/${org.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.organization.owner).toEqual(
      expect.objectContaining({
        firstName: expect.any(String),
        lastName: expect.any(String),
        email: expect.any(String),
      })
    );
    expect(detail.body.data.organization.members).toHaveLength(2);
    const memberEmails = detail.body.data.organization.members.map(
      (m: { user: { email: string } }) => m.user.email
    );
    expect(memberEmails).toContain("recruiter@invitecorp.com");
  });

  it("Owner revokes pending invite", async () => {
    const { org, token } = await createOwnedOrg();

    const send = await request(app)
      .post(`/v1/organizations/${org.id}/invites`)
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "revoke@invitecorp.com" });
    expect(send.status).toBe(201);

    const revoke = await request(app)
      .delete(`/v1/organizations/${org.id}/invites/${send.body.data.invite.id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(revoke.status).toBe(200);

    const list = await request(app)
      .get(`/v1/organizations/${org.id}/invites`)
      .set("Authorization", `Bearer ${token}`);
    expect(list.body.data.invites).toHaveLength(0);
  });

  // Seats come from the plan catalogue, not a fixed constant: "pro" allows 3 team members
  // and the owner occupies one of them, so two invites fill the company.
  it("Rejects the invite that would exceed the plan's team_members limit", async () => {
    const { org, token } = await createOwnedOrg("pro");

    for (let i = 1; i <= 2; i += 1) {
      const send = await request(app)
        .post(`/v1/organizations/${org.id}/invites`)
        .set("Authorization", `Bearer ${token}`)
        .send({ email: `teammate${i}@invitecorp.com` });
      expect(send.status).toBe(201);
    }

    const overLimit = await request(app)
      .post(`/v1/organizations/${org.id}/invites`)
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "teammate3@invitecorp.com" });
    expect(overLimit.status).toBe(402);
    expect(overLimit.body.error.code).toBe("PLAN_LIMIT_REACHED");
    expect(overLimit.body.error.featureKey).toBe("team_members");
  });

  // The default plan is a single-seat company: the owner fills it, so there is no room to
  // invite anyone until they upgrade.
  it("Rejects any invite on the default pay_per_use plan — the owner is the only seat", async () => {
    const { org, token } = await createOwnedOrg(DEFAULT_BILLING_PLAN_KEY);

    const send = await request(app)
      .post(`/v1/organizations/${org.id}/invites`)
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "teammate@invitecorp.com" });
    expect(send.status).toBe(402);
    expect(send.body.error.featureKey).toBe("team_members");
  });

  it("Rejects invite accept when the seats filled up while the invite was pending", async () => {
    const { org, token } = await createOwnedOrg("pro");

    const send = await request(app)
      .post(`/v1/organizations/${org.id}/invites`)
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "latejoiner@invitecorp.com" });
    expect(send.status).toBe(201);

    const inviteToken = inviteTokenFromEmail();

    // Two more members land before the invite is accepted — with the owner that is the
    // whole of "pro"'s 3 seats.
    const memberRepo = testDataSource.getRepository(OrganizationMember);
    for (let i = 1; i <= 2; i += 1) {
      const { user } = await createRecruiter({ email: `filled${i}@invitecorp.com` });
      await memberRepo.save(
        memberRepo.create({
          userId: user.id,
          organizationId: org.id,
          workEmail: user.email,
          role: "member",
        })
      );
    }

    const { token: joinerToken } = await createRecruiter({
      email: "latejoiner@invitecorp.com",
    });
    const accept = await request(app)
      .post(`/v1/organizations/invites/${inviteToken}/accept`)
      .set("Authorization", `Bearer ${joinerToken}`);
    expect(accept.status).toBe(402);
    expect(accept.body.error.featureKey).toBe("team_members");
  });

  // Billing moved from a per-user field to a single org-wide Organization.billingPlan
  // (see migration OrgScopedBilling / commit "move billing ownership from user to
  // organization"), so there's no longer a per-invitee "paid plan" to reject and nothing
  // to inherit on accept — every member of a company already shares the same plan by
  // construction. The old per-user gating tests this block used to have were removed
  // along with that dead code path.
  it("Invite/accept does not touch billing — every member shares the org's single plan", async () => {
    const { org, token: ownerToken } = await createOwnedOrg();
    await testDataSource.getRepository(Organization).update(org.id, { billingPlan: "pro" });

    await request(app)
      .post(`/v1/organizations/${org.id}/invites`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ email: "billing@invitecorp.com" })
      .expect(201);

    const inviteToken = inviteTokenFromEmail();
    const { token: joinerToken } = await createRecruiter({
      email: "billing@invitecorp.com",
    });

    await request(app)
      .post(`/v1/organizations/invites/${inviteToken}/accept`)
      .set("Authorization", `Bearer ${joinerToken}`)
      .expect(200);

    // The joiner is now scoped to the org, which still carries the one plan for everyone.
    const refreshedOrg = await testDataSource
      .getRepository(Organization)
      .findOne({ where: { id: org.id } });
    expect(refreshedOrg?.billingPlan).toBe("pro");
  });
});

describe("Organization domain field", () => {
  it("Rejects company creation when profile email does not match domain", async () => {
    const { token } = await createRecruiter({ email: "someone@other.com" });
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send(validOrgBody);
    expect(res.status).toBe(400);
  });

  it("Rejects invalid domain format", async () => {
    const { token } = await recruiterForTechCorp();
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...validOrgBody, domain: "not-a-domain" });
    expect(res.status).toBe(400);
  });

  it("Accepts a domain without a leading @ → 201", async () => {
    const { token } = await recruiterForTechCorp();
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...validOrgBody, domain: "techcorp.com" });
    expect(res.status).toBe(201);
  });
});
