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
import { Job, OrganizationMember, User } from "../src/entities";
import { BillingPlan, BillingStatus } from "../src/types/enums.js";
import {
  createTalent,
  createRecruiter,
  createAdmin,
  createOrganization,
  createRole,
  createJob,
} from "./helpers/fixtures.js";

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

  it("Missing both website and LinkedIn → 400", async () => {
    const { token } = await recruiterForTechCorp();
    const { website: _website, ...bodyWithoutWebsite } = validOrgBody;
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send(bodyWithoutWebsite);
    expect(res.status).toBe(400);
  });

  it("LinkedIn provided without a website → 201", async () => {
    const { token } = await recruiterForTechCorp();
    const { website: _website, ...bodyWithoutWebsite } = validOrgBody;
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send({ ...bodyWithoutWebsite, linkedin: "https://linkedin.com/company/techcorp" });
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
        logoUrl: "https://cdn.example.com/logo.png",
      });

    expect(res.status).toBe(200);
    expect(res.body.data.organization.name).toBe("New Name");
    expect(res.body.data.organization.industry).toBe("Fintech");
    expect(res.body.data.organization.logoUrl).toBe("https://cdn.example.com/logo.png");
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

  it("Rejects an invalid logo URL → 400", async () => {
    const { user: recruiter, token } = await createRecruiter();
    const org = await createOrganization(recruiter);

    const res = await request(app)
      .patch(`/v1/organizations/${org.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ logoUrl: "not-a-url" });

    expect(res.status).toBe(400);
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

  it("Non-owner recruiter cannot delete → 403", async () => {
    const { user: owner } = await createRecruiter();
    const { token: otherToken } = await createRecruiter();
    const org = await createOrganization(owner);

    const res = await request(app)
      .delete(`/v1/organizations/${org.id}`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(403);
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
  };

  async function createOwnedOrg() {
    const { token, user } = await createRecruiter({ email: "owner@invitecorp.com" });
    const res = await request(app)
      .post("/v1/organizations/")
      .set("Authorization", `Bearer ${token}`)
      .send(corporateOrgBody);
    expect(res.status).toBe(201);
    return { org: res.body.data.organization, token, user };
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

  it("Rejects a seventh teammate invite when 6 recruiters plus the creator already occupy seats", async () => {
    const { org, token } = await createOwnedOrg();

    for (let i = 1; i <= 6; i += 1) {
      const send = await request(app)
        .post(`/v1/organizations/${org.id}/invites`)
        .set("Authorization", `Bearer ${token}`)
        .send({ email: `teammate${i}@invitecorp.com` });
      expect(send.status).toBe(201);
    }

    const seventh = await request(app)
      .post(`/v1/organizations/${org.id}/invites`)
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "teammate7@invitecorp.com" });
    expect(seventh.status).toBe(400);
    expect(seventh.body.error.message).toMatch(/6 recruiters plus the creator/i);
  });

  it("Rejects invite accept when the company already has 6 teammates", async () => {
    const { org, token } = await createOwnedOrg();

    const send = await request(app)
      .post(`/v1/organizations/${org.id}/invites`)
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "latejoiner@invitecorp.com" });
    expect(send.status).toBe(201);

    const inviteToken = inviteTokenFromEmail();

    const memberRepo = testDataSource.getRepository(OrganizationMember);
    for (let i = 1; i <= 6; i += 1) {
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
    expect(accept.status).toBe(400);
    expect(accept.body.error.message).toMatch(/6 recruiters plus the creator/i);
  });

  it("Rejects invite when invitee is on a paid plan", async () => {
    const { org, token } = await createOwnedOrg();
    await createRecruiter({
      email: "paid@invitecorp.com",
      billingPlan: BillingPlan.Paid,
      billingStatus: BillingStatus.Active,
    });

    const res = await request(app)
      .post(`/v1/organizations/${org.id}/invites`)
      .set("Authorization", `Bearer ${token}`)
      .send({ email: "paid@invitecorp.com" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/paid plan/i);
  });

  it("Inherits owner billing plan when invite is accepted", async () => {
    const { org, token: ownerToken, user: owner } = await createOwnedOrg();
    await testDataSource.getRepository(User).update(owner.id, {
      billingPlan: BillingPlan.Paid,
      billingStatus: BillingStatus.Active,
    });

    await request(app)
      .post(`/v1/organizations/${org.id}/invites`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ email: "billing@invitecorp.com" })
      .expect(201);

    const inviteToken = inviteTokenFromEmail();
    const { user: joiner, token: joinerToken } = await createRecruiter({
      email: "billing@invitecorp.com",
    });

    await request(app)
      .post(`/v1/organizations/invites/${inviteToken}/accept`)
      .set("Authorization", `Bearer ${joinerToken}`)
      .expect(200);

    const refreshed = await testDataSource.getRepository(User).findOne({
      where: { id: joiner.id },
    });
    expect(refreshed?.billingPlan).toBe(BillingPlan.Paid);
    expect(refreshed?.billingStatus).toBe(BillingStatus.Active);
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
      .send({ ...validOrgBody, domain: "acme.com" });
    expect(res.status).toBe(400);
  });
});
