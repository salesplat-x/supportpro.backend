/**
 * Staff invites — HR-only sending, joining by logging in or setting a password,
 * and the guarantee that staff never receive HR rights.
 */

import crypto from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import {
  Organization,
  OrganizationInvite,
  OrganizationMember,
  StaffActivity,
  StaffMember,
  User,
} from "../src/entities";
import {
  createCompleteTalent,
  createRecruiter,
  createRole,
  createTalent,
  PLAIN_PASSWORD,
} from "./helpers/fixtures.js";
import { apiData } from "./helpers/http.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { createStaff, postStaff, staffPath, type StaffViewShape } from "./helpers/staff.js";
import { OrganizationStatus } from "../src/types/enums.js";
import env from "../src/config/env.js";
import { assertCanManagePeople } from "../src/services/peopleAccess.js";
import { AuthorizationError } from "../src/utils/errors";

jest.mock("../src/utils/integrations/email/emailService.js", () => {
  const sendStaffInvite = jest.fn().mockResolvedValue(undefined);
  const sendVerificationEmail = jest.fn().mockResolvedValue(undefined);
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      sendWelcome: jest.fn().mockResolvedValue(undefined),
      sendVerificationEmail,
      sendCompanyInvite: jest.fn().mockResolvedValue(undefined),
      sendStaffInvite,
    })),
    sendStaffInvite,
    sendVerificationEmail,
  };
});

interface StaffInviteEmail {
  email: string;
  companyName: string;
  inviterName: string;
  jobTitle: string;
  inviteLink: string;
}

const emailMocks = () =>
  jest.requireMock("../src/utils/integrations/email/emailService.js") as {
    sendStaffInvite: jest.Mock<Promise<void>, [StaffInviteEmail]>;
    sendVerificationEmail: jest.Mock<Promise<void>, [unknown, string, string?]>;
  };

const tokenFromLastEmail = (): string => {
  const token = emailMocks().sendStaffInvite.mock.calls.at(-1)?.[0].inviteLink.split("/").pop();
  if (!token) throw new Error("Staff invite email was not sent");
  return token;
};

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

const staffRow = (id: string) => testDataSource.getRepository(StaffMember).findOneByOrFail({ id });

const activityTypes = async (staffId: string) =>
  (
    await testDataSource
      .getRepository(StaffActivity)
      .find({ where: { staffId }, order: { createdAt: "ASC" } })
  ).map((a) => a.type);

const invite = (
  token: string,
  orgId: string,
  staffId: string,
  body: Record<string, unknown> = {}
) =>
  request(app)
    .post(staffPath(orgId, `/${staffId}/invite`))
    .set(authHeader(token))
    .send(body);

const accept = (token: string, inviteToken: string) =>
  request(app).post(`/v1/staff-invites/${inviteToken}/accept`).set(authHeader(token));

const expireCooldown = (staffId: string) =>
  testDataSource
    .getRepository(StaffMember)
    .update(staffId, { invitedAt: new Date(Date.now() - 5 * 60_000) });

async function invitedStaff(email = "invitee@example.com") {
  const company = await setupCompany();
  const hr = await addMember(company.org, { canManagePeople: true });
  const staff = await createStaff(app, hr.token, company.org.id, {
    email,
    sendInvite: true,
  });
  return { ...company, hr, staff, inviteToken: tokenFromLastEmail() };
}

describe("sending invites", () => {
  it("emails the invite naming the HR who sent it, and records who invited", async () => {
    const { org, hr, staff } = await invitedStaff("ada@example.com");

    expect(staff.status).toBe("invited");
    expect(staff.invite).toMatchObject({ state: "pending", invitedByName: "Hana Resources" });
    expect(emailMocks().sendStaffInvite).toHaveBeenCalledTimes(1);
    expect(emailMocks().sendStaffInvite.mock.calls[0]?.[0]).toMatchObject({
      email: "ada@example.com",
      companyName: "Acme Ltd",
      inviterName: "Hana Resources",
      jobTitle: "Product Designer",
      inviteLink: expect.stringMatching(/\/join-staff\/[a-f0-9]{64}$/),
    });
    expect(await activityTypes(staff.id)).toEqual(["created", "invited"]);

    const row = await staffRow(staff.id);
    expect(row).toMatchObject({ invitedById: hr.user.id, invitedByName: "Hana Resources" });
    expect(row.organizationId).toBe(org.id);
  });

  it("never exposes the token and stores only its hash", async () => {
    const { org, hr, staff, inviteToken } = await invitedStaff();
    const row = await staffRow(staff.id);
    expect(row.inviteTokenHash).toBe(crypto.createHash("sha256").update(inviteToken).digest("hex"));
    expect(row.inviteTokenHash).not.toBe(inviteToken);

    const detail = await request(app)
      .get(staffPath(org.id, `/${staff.id}`))
      .set(authHeader(hr.token));
    const list = await request(app).get(staffPath(org.id)).set(authHeader(hr.token));
    for (const res of [detail, list]) {
      expect(JSON.stringify(res.body)).not.toContain(inviteToken);
      expect(JSON.stringify(res.body)).not.toContain(row.inviteTokenHash);
    }
  });

  it("invites an existing outside hire later without changing their status", async () => {
    const { owner, org } = await setupCompany();
    const staff = await createStaff(app, owner.token, org.id);
    const res = await invite(owner.token, org.id, staff.id);

    expect(res.status).toBe(200);
    const view = apiData<{ staff: StaffViewShape; inviteEmailSent: boolean }>(res);
    expect(view.inviteEmailSent).toBe(true);
    expect(view.staff).toMatchObject({ status: "active" });
    expect(view.staff.invite.state).toBe("pending");
    expect(emailMocks().sendStaffInvite).toHaveBeenCalledTimes(1);
  });

  it("lets only HR send an invite", async () => {
    const { owner, org } = await setupCompany();
    const plain = await addMember(org);
    const outsider = await createRecruiter();
    const staff = await createStaff(app, owner.token, org.id);

    expect((await invite(plain.token, org.id, staff.id)).status).toBe(403);
    expect((await invite(outsider.token, org.id, staff.id)).status).toBe(403);
    expect((await postStaff(app, plain.token, org.id, { sendInvite: true })).status).toBe(403);
    expect(emailMocks().sendStaffInvite).not.toHaveBeenCalled();
  });

  it("resends with a new token, voiding the old one, and logs the resend", async () => {
    const { org, hr, staff, inviteToken } = await invitedStaff();
    await expireCooldown(staff.id);

    const res = await invite(hr.token, org.id, staff.id);
    expect(res.status).toBe(200);
    const newToken = tokenFromLastEmail();
    expect(newToken).not.toBe(inviteToken);
    expect((await request(app).get(`/v1/staff-invites/${inviteToken}`)).status).toBe(404);
    expect(await activityTypes(staff.id)).toEqual(["created", "invited", "invite_resent"]);
    expect((await request(app).get(`/v1/staff-invites/${newToken}`)).status).toBe(200);
  });

  it("makes HR wait a minute between resends", async () => {
    const { org, hr, staff } = await invitedStaff();
    const res = await invite(hr.token, org.id, staff.id);
    expect(res.status).toBe(429);
    expect(emailMocks().sendStaffInvite).toHaveBeenCalledTimes(1);
  });

  it("keeps the record and reports it when the email cannot be sent", async () => {
    const { owner, org } = await setupCompany();
    emailMocks().sendStaffInvite.mockRejectedValueOnce(new Error("provider down"));
    const res = await postStaff(app, owner.token, org.id, { sendInvite: true });

    expect(res.status).toBe(201);
    const data = apiData<{ staff: StaffViewShape; inviteEmailSent: boolean }>(res);
    expect(data.inviteEmailSent).toBe(false);
    expect(await activityTypes(data.staff.id)).toEqual(["created", "invited", "invite_failed"]);
  });

  it("refuses to invite the company's own owner or members", async () => {
    const { owner, org } = await setupCompany();
    const member = await addMember(org, { canManagePeople: true });

    const ownerRes = await postStaff(app, owner.token, org.id, {
      email: owner.user.email,
      sendInvite: true,
    });
    const memberRes = await postStaff(app, owner.token, org.id, {
      email: member.user.email,
      sendInvite: true,
    });
    expect([ownerRes.status, memberRes.status]).toEqual([409, 409]);

    const recordOnly = await postStaff(app, owner.token, org.id, { email: owner.user.email });
    expect(recordOnly.status).toBe(201);
    expect(emailMocks().sendStaffInvite).not.toHaveBeenCalled();
  });

  it("stops a rejected company from emailing invites but not from keeping records", async () => {
    const { owner, org } = await setupCompany();
    await testDataSource
      .getRepository(Organization)
      .update(org.id, { status: OrganizationStatus.Rejected });

    expect((await postStaff(app, owner.token, org.id, { sendInvite: true })).status).toBe(403);
    expect((await postStaff(app, owner.token, org.id)).status).toBe(201);
    expect(emailMocks().sendStaffInvite).not.toHaveBeenCalled();
  });

  it("refuses to invite someone who already joined or has left", async () => {
    const { owner, org } = await setupCompany();
    const joined = await createStaff(app, owner.token, org.id);
    const left = await createStaff(app, owner.token, org.id);
    const { user } = await createTalent();
    await testDataSource
      .getRepository(StaffMember)
      .update(joined.id, { userId: user.id, joinedAt: new Date() });
    await request(app)
      .post(staffPath(org.id, `/${left.id}/end`))
      .set(authHeader(owner.token))
      .send({});

    expect([
      (await invite(owner.token, org.id, joined.id)).status,
      (await invite(owner.token, org.id, left.id)).status,
    ]).toEqual([409, 409]);
  });

  it("lets HR invite again after the person's account was deleted", async () => {
    const { owner, org } = await setupCompany();
    const staff = await createStaff(app, owner.token, org.id, { email: "gone@example.com" });
    const { user } = await createTalent({ email: "gone@example.com" });
    await testDataSource
      .getRepository(StaffMember)
      .update(staff.id, { userId: user.id, joinedAt: new Date() });
    expect((await invite(owner.token, org.id, staff.id)).status).toBe(409);

    await testDataSource.getRepository(User).delete(user.id);
    const res = await invite(owner.token, org.id, staff.id);
    expect(res.status).toBe(200);
    expect(apiData<{ staff: StaffViewShape }>(res).staff).toMatchObject({
      hasAccount: false,
      invite: { state: "pending", joinedAt: null },
    });
  });

  it("refuses to invite an address that is a team member's work email", async () => {
    const { owner, org } = await setupCompany();
    const member = await addMember(org);
    await testDataSource
      .getRepository(OrganizationMember)
      .update(member.memberId, { workEmail: "Hana.Work@Acme.com" });

    const res = await postStaff(app, owner.token, org.id, {
      email: "hana.work@acme.com",
      sendInvite: true,
    });
    expect(res.status).toBe(409);
  });

  it("reports a missing website setting as a failed email instead of sending a broken link", async () => {
    const { owner, org } = await setupCompany();
    const settings = env as { website?: string };
    const original = settings.website;
    settings.website = undefined;
    try {
      const res = await postStaff(app, owner.token, org.id, { sendInvite: true });
      expect(res.status).toBe(201);
      const data = apiData<{ staff: StaffViewShape; inviteEmailSent: boolean }>(res);
      expect(data.inviteEmailSent).toBe(false);
      expect(await activityTypes(data.staff.id)).toEqual(["created", "invited", "invite_failed"]);
      expect(emailMocks().sendStaffInvite).not.toHaveBeenCalled();
    } finally {
      settings.website = original;
    }
  });

  it("voids the invite when employment ends", async () => {
    const { org, hr, staff, inviteToken } = await invitedStaff();
    await request(app)
      .post(staffPath(org.id, `/${staff.id}/end`))
      .set(authHeader(hr.token))
      .send({});

    const preview = await request(app).get(`/v1/staff-invites/${inviteToken}`);
    expect(preview.status).toBe(404);
  });
});

describe("previewing an invite", () => {
  it("shows the company, role and inviter to whoever holds the link, and logs the first open once", async () => {
    const { staff, inviteToken } = await invitedStaff("ada@example.com");

    const first = await request(app).get(`/v1/staff-invites/${inviteToken}`);
    expect(first.status).toBe(200);
    expect(apiData<{ invite: unknown }>(first).invite).toMatchObject({
      status: "pending",
      organizationName: "Acme Ltd",
      jobTitle: "Product Designer",
      invitedEmail: "ada@example.com",
      invitedByName: "Hana Resources",
      inviteeExists: false,
    });
    await request(app).get(`/v1/staff-invites/${inviteToken}`);
    expect(await activityTypes(staff.id)).toEqual(["created", "invited", "invite_opened"]);
  });

  it("says whether the invited email already has an account", async () => {
    const { inviteToken } = await invitedStaff("existing@example.com");
    await createTalent({ email: "existing@example.com" });
    const res = await request(app).get(`/v1/staff-invites/${inviteToken}`);
    expect(apiData<{ invite: { inviteeExists: boolean } }>(res).invite.inviteeExists).toBe(true);
  });

  it("tells an expired invite who sent it and when, and gives only the status once used", async () => {
    const { staff, inviteToken, hr } = await invitedStaff();
    const expiresAt = new Date(Date.now() - 60_000);
    await testDataSource
      .getRepository(StaffMember)
      .update(staff.id, { inviteExpiresAt: expiresAt });

    const expired = await request(app).get(`/v1/staff-invites/${inviteToken}`);
    expect(apiData<{ invite: Record<string, unknown> }>(expired).invite).toMatchObject({
      status: "expired",
      organizationName: "Acme Ltd",
      invitedEmail: "invitee@example.com",
      expiresAt: expiresAt.toISOString(),
      contactEmail: hr.user.email,
    });
    expect(
      apiData<{ invite: { invitedAt: string | null } }>(expired).invite.invitedAt
    ).not.toBeNull();
    expect(await activityTypes(staff.id)).not.toContain("invite_opened");

    const { user } = await createTalent();
    await testDataSource.getRepository(StaffMember).update(staff.id, {
      inviteExpiresAt: new Date(Date.now() + 60_000),
      userId: user.id,
      joinedAt: new Date(),
    });
    const used = await request(app).get(`/v1/staff-invites/${inviteToken}`);
    expect(apiData<{ invite: unknown }>(used).invite).toEqual({ status: "accepted" });

    expect((await request(app).get(`/v1/staff-invites/${"0".repeat(64)}`)).status).toBe(404);
  });
});

describe("joining", () => {
  it("does not attach anyone when they register and verify their email", async () => {
    const { staff } = await invitedStaff("newbie@example.com");

    const register = await request(app).post("/v1/auth/register").send({
      email: "newbie@example.com",
      firstName: "New",
      lastName: "Bie",
      password: PLAIN_PASSWORD,
    });
    expect(register.status).toBe(201);
    const verifyToken = emailMocks().sendVerificationEmail.mock.calls.at(-1)?.[1];
    const verify = await request(app).post("/v1/auth/verify-email").send({ token: verifyToken });
    expect(verify.status).toBe(200);

    const row = await staffRow(staff.id);
    expect(row).toMatchObject({ userId: null, status: "invited", joinedAt: null });
    expect(await activityTypes(staff.id)).not.toContain("joined");
  });

  it("lets registration send the person back to the join page after verifying", async () => {
    const { inviteToken } = await invitedStaff("back@example.com");
    const register = (redirectPath: string) =>
      request(app).post("/v1/auth/register").send({
        email: "back@example.com",
        firstName: "Back",
        lastName: "Again",
        password: PLAIN_PASSWORD,
        redirectPath,
      });

    expect((await register("https://evil.example.com/join-staff/abc")).status).toBe(400);
    expect((await register(`/join-staff/${inviteToken}`)).status).toBe(201);
    expect(emailMocks().sendVerificationEmail.mock.calls.at(-1)?.[2]).toBe(
      `/join-staff/${inviteToken}`
    );
  });

  it("attaches a person whose talent profile is not filled in yet", async () => {
    const { staff, inviteToken } = await invitedStaff("half@example.com");
    const talent = await createTalent({ email: "half@example.com" });

    const res = await accept(talent.token, inviteToken);
    expect(res.status).toBe(200);
    expect(await staffRow(staff.id)).toMatchObject({ userId: talent.user.id, status: "active" });
  });

  it("verifies an unverified account through the emailed link, but not from My work", async () => {
    const { staff, inviteToken } = await invitedStaff("fresh@example.com");
    const talent = await createTalent({ email: "fresh@example.com", emailVerifiedAt: null });

    const fromMyWork = await request(app)
      .post(`/v1/staff-invites/mine/${staff.id}/accept`)
      .set(authHeader(talent.token));
    expect(fromMyWork.status).toBe(403);

    expect((await accept(talent.token, inviteToken)).status).toBe(200);
    const user = await testDataSource.getRepository(User).findOneByOrFail({ id: talent.user.id });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect((await staffRow(staff.id)).userId).toBe(talent.user.id);
  });

  it("returns the same join on a retry and reports what is waiting in My work", async () => {
    const { org, staff, inviteToken } = await invitedStaff("again@example.com");
    const talent = await createTalent({ email: "again@example.com" });
    await testDataSource
      .getRepository(StaffMember)
      .query(
        `INSERT INTO "staff_checklist_tasks" ("staff_id", "title") VALUES ($1, 'Read handbook'), ($1, 'Set up laptop')`,
        [staff.id]
      );

    const first = apiData<{ joined: Record<string, unknown> }>(
      await accept(talent.token, inviteToken)
    ).joined;
    const retry = apiData<{ joined: Record<string, unknown> }>(
      await accept(talent.token, inviteToken)
    ).joined;
    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      organizationName: "Acme Ltd",
      documentsToSign: 0,
      openTasks: expect.any(Number),
      hasPay: false,
      hasShareOptions: false,
    });
    expect(first["openTasks"]).toBeGreaterThanOrEqual(2);
    expect(org.id).toBeTruthy();
  });

  it("attaches a registered, verified person with a complete profile and records it", async () => {
    const { org, hr, staff, inviteToken } = await invitedStaff("full@example.com");
    const role = await createRole();
    const talent = await createCompleteTalent(role, { email: "full@example.com" });

    const res = await accept(talent.token, inviteToken);
    expect(res.status).toBe(200);
    expect(apiData<{ joined: unknown }>(res).joined).toMatchObject({
      organizationName: "Acme Ltd",
      jobTitle: "Product Designer",
    });

    const row = await staffRow(staff.id);
    expect(row).toMatchObject({ userId: talent.user.id, status: "active" });
    expect(row.joinedAt).not.toBeNull();
    expect(await activityTypes(staff.id)).toEqual(["created", "invited", "joined"]);

    const view = await request(app)
      .get(staffPath(org.id, `/${staff.id}`))
      .set(authHeader(hr.token));
    expect(apiData<{ staff: StaffViewShape }>(view).staff).toMatchObject({
      status: "active",
      hasAccount: true,
    });
    expect(apiData<{ staff: StaffViewShape }>(view).staff.invite.state).toBe("accepted");
  });

  it("treats a repeat click by the same person as success and refuses anyone else", async () => {
    const { inviteToken } = await invitedStaff("full@example.com");
    const role = await createRole();
    const talent = await createCompleteTalent(role, { email: "full@example.com" });
    const stranger = await createCompleteTalent(role, { email: "stranger@example.com" });

    expect((await accept(talent.token, inviteToken)).status).toBe(200);
    expect((await accept(talent.token, inviteToken)).status).toBe(200);
    expect((await accept(stranger.token, inviteToken)).status).toBe(403);
  });

  it("refuses the wrong email, a recruiter account, an unverified wrong account and an unknown link", async () => {
    const { inviteToken } = await invitedStaff("full@example.com");
    const role = await createRole();
    const wrongEmail = await createCompleteTalent(role, { email: "other@example.com" });
    const recruiter = await createRecruiter({ email: "full@example.com" });
    const unverified = await createCompleteTalent(role, {
      email: "unverified@example.com",
      emailVerifiedAt: null,
    });

    expect((await accept(wrongEmail.token, inviteToken)).status).toBe(403);
    expect((await accept(recruiter.token, inviteToken)).status).toBe(403);
    expect((await accept(unverified.token, inviteToken)).status).toBe(403);
    expect((await accept(wrongEmail.token, "0".repeat(64))).status).toBe(404);
  });

  it("refuses an expired invite", async () => {
    const { staff, inviteToken } = await invitedStaff("full@example.com");
    const talent = await createCompleteTalent(await createRole(), { email: "full@example.com" });
    await testDataSource
      .getRepository(StaffMember)
      .update(staff.id, { inviteExpiresAt: new Date(Date.now() - 60_000) });

    const res = await accept(talent.token, inviteToken);
    expect(res.status).toBe(400);
    expect((await staffRow(staff.id)).userId).toBeNull();
  });

  it("matches the invited email even when the address was typed with Gmail dots", async () => {
    const company = await setupCompany();
    await createStaff(app, company.owner.token, company.org.id, {
      email: "jane.doe+hr@gmail.com",
      sendInvite: true,
    });
    const inviteToken = tokenFromLastEmail();
    const talent = await createCompleteTalent(await createRole(), { email: "janedoe@gmail.com" });

    expect((await accept(talent.token, inviteToken)).status).toBe(200);
  });
});

describe("joining by setting a password", () => {
  const setPassword = (inviteToken: string, password = PLAIN_PASSWORD) =>
    request(app).post(`/v1/staff-invites/${inviteToken}/password`).send({ password });

  it("creates a verified talent account, joins, and signs the person in", async () => {
    const { staff, inviteToken } = await invitedStaff("kelechi@example.com");

    const res = await setPassword(inviteToken);
    expect(res.status).toBe(201);
    const body = apiData<{ user: { id: string; email: string }; token: string; joined: unknown }>(
      res
    );
    expect(body.token).toEqual(expect.any(String));
    expect(body.joined).toMatchObject({
      organizationName: "Acme Ltd",
      jobTitle: "Product Designer",
    });
    expect(JSON.stringify(body.user)).not.toContain("password");

    const user = await testDataSource.getRepository(User).findOneByOrFail({ id: body.user.id });
    expect(user).toMatchObject({
      email: "kelechi@example.com",
      userRole: "talent",
      firstName: "Ada",
      lastName: "Obi",
      activeOrganizationId: null,
    });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(
      await testDataSource.getRepository(OrganizationMember).countBy({ userId: user.id })
    ).toBe(0);
    expect(await staffRow(staff.id)).toMatchObject({ userId: user.id, status: "active" });
    expect(emailMocks().sendVerificationEmail).not.toHaveBeenCalled();

    const login = await request(app)
      .post("/v1/auth/login")
      .send({ email: "kelechi@example.com", password: PLAIN_PASSWORD });
    expect(login.status).toBe(200);
    const me = await request(app).get("/v1/user/me").set(authHeader(body.token));
    expect(apiData<{ user: { hasJoinedStaff: boolean } }>(me).user.hasJoinedStaff).toBe(true);
  });

  it("uses a one-word name for both first and last name", async () => {
    const company = await setupCompany();
    await createStaff(app, company.owner.token, company.org.id, {
      fullName: "Madonna",
      email: "madonna@example.com",
      sendInvite: true,
    });
    const res = await setPassword(tokenFromLastEmail());
    expect(res.status).toBe(201);
    const user = await testDataSource
      .getRepository(User)
      .findOneByOrFail({ email: "madonna@example.com" });
    expect(user).toMatchObject({ firstName: "Madonna", lastName: "Madonna" });
  });

  it("sends anyone who already has an account to log in instead", async () => {
    const { staff, inviteToken } = await invitedStaff("taken@example.com");
    await createRecruiter({ email: "taken@example.com" });

    const res = await setPassword(inviteToken);
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe("ACCOUNT_EXISTS");
    expect((await staffRow(staff.id)).userId).toBeNull();
  });

  it("refuses a weak password, an expired, used, ended or unknown invite", async () => {
    const { org, owner, staff, inviteToken } = await invitedStaff("ref@example.com");
    expect((await setPassword(inviteToken, "short")).status).toBe(400);
    expect((await setPassword("0".repeat(64))).status).toBe(404);

    await testDataSource
      .getRepository(StaffMember)
      .update(staff.id, { inviteExpiresAt: new Date(Date.now() - 60_000) });
    expect((await setPassword(inviteToken)).status).toBe(400);

    await testDataSource
      .getRepository(StaffMember)
      .update(staff.id, { inviteExpiresAt: new Date(Date.now() + 60_000) });
    const ended = await request(app)
      .post(staffPath(org.id, `/${staff.id}/end`))
      .set(authHeader(owner.token))
      .send({});
    expect(ended.status).toBe(200);
    expect((await setPassword(inviteToken)).status).toBe(404);
    expect(await testDataSource.getRepository(User).countBy({ email: "ref@example.com" })).toBe(0);
  });

  it("lets only one of two simultaneous attempts create the account", async () => {
    const { staff, inviteToken } = await invitedStaff("race@example.com");

    const results = await Promise.all([setPassword(inviteToken), setPassword(inviteToken)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await testDataSource.getRepository(User).countBy({ email: "race@example.com" })).toBe(1);
    expect(await activityTypes(staff.id)).toEqual(["created", "invited", "joined"]);
  });

  it("keeps no account behind when joining fails after the account is made", async () => {
    const { staff, inviteToken } = await invitedStaff("rollback@example.com");
    await testDataSource.query(
      `CREATE OR REPLACE FUNCTION fail_join() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql`
    );
    await testDataSource.query(
      `CREATE TRIGGER fail_join BEFORE UPDATE OF "user_id" ON "staff_members" FOR EACH ROW EXECUTE FUNCTION fail_join()`
    );
    try {
      expect((await setPassword(inviteToken)).status).toBe(500);
    } finally {
      await testDataSource.query(`DROP TRIGGER fail_join ON "staff_members"`);
      await testDataSource.query(`DROP FUNCTION fail_join()`);
    }
    expect(
      await testDataSource.getRepository(User).countBy({ email: "rollback@example.com" })
    ).toBe(0);
    expect((await staffRow(staff.id)).userId).toBeNull();
    expect((await setPassword(inviteToken)).status).toBe(201);
  });

  it("lets a person whose reply was lost log in with the new password and join again", async () => {
    const { inviteToken } = await invitedStaff("lost@example.com");
    expect((await setPassword(inviteToken)).status).toBe(201);
    expect((await setPassword(inviteToken)).status).toBe(409);

    const login = await request(app)
      .post("/v1/auth/login")
      .send({ email: "lost@example.com", password: PLAIN_PASSWORD });
    const token = apiData<{ token: string }>(login).token;
    expect((await accept(token, inviteToken)).status).toBe(200);
  });
});

describe("staff never get HR rights", () => {
  async function joinedStaff() {
    const company = await invitedStaff("full@example.com");
    const talent = await createCompleteTalent(await createRole(), { email: "full@example.com" });
    expect((await accept(talent.token, company.inviteToken)).status).toBe(200);
    return { ...company, talent };
  }

  it("gives a joined employee no membership, no active company and no HR flag", async () => {
    const { org, talent } = await joinedStaff();

    expect(
      await testDataSource
        .getRepository(OrganizationMember)
        .count({ where: { userId: talent.user.id } })
    ).toBe(0);
    const user = await testDataSource.getRepository(User).findOneByOrFail({ id: talent.user.id });
    expect(user.activeOrganizationId).toBeNull();
    await expect(assertCanManagePeople(talent.user.id, org.id)).rejects.toBeInstanceOf(
      AuthorizationError
    );
  });

  it("refuses a joined employee on every staff route and on the HR switch", async () => {
    const { org, hr, staff, talent } = await joinedStaff();
    const h = authHeader(talent.token);

    const responses = await Promise.all([
      request(app).get(staffPath(org.id, "/access")).set(h),
      request(app).get(staffPath(org.id)).set(h),
      request(app)
        .get(staffPath(org.id, `/${staff.id}`))
        .set(h),
      request(app).post(staffPath(org.id)).set(h).send({}),
      request(app)
        .patch(staffPath(org.id, `/${staff.id}`))
        .set(h)
        .send({ jobTitle: "CEO" }),
      request(app).get(staffPath(org.id, "/access-log")).set(h),
      request(app)
        .patch(`/v1/organizations/${org.id}/members/${hr.memberId}`)
        .set(h)
        .send({ canManagePeople: true }),
    ]);
    expect(responses.map((r) => r.status)).toEqual(Array(responses.length).fill(403));
  });

  it("stops a joined employee joining the company as a recruiter", async () => {
    const { owner, org, talent } = await joinedStaff();
    const companyInvite = await testDataSource.getRepository(OrganizationInvite).save({
      organizationId: org.id,
      email: talent.user.email,
      token: "f".repeat(64),
      invitedById: owner.user.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const acceptInvite = await request(app)
      .post(`/v1/organizations/invites/${companyInvite.token}/accept`)
      .set(authHeader(talent.token));
    const joinRequest = await request(app)
      .post(`/v1/organizations/${org.id}/join-request`)
      .set(authHeader(talent.token))
      .send({ workEmail: talent.user.email });
    expect([acceptInvite.status, joinRequest.status]).toEqual([403, 403]);
  });
});
