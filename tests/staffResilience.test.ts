/**
 * Staff records under failure — a failing database write behind an email failure, a stalled
 * email provider, a preview that fails halfway, hostile input, simultaneous requests and callers
 * who should never get in.
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
import { Organization, StaffAccessLog, StaffActivity, StaffMember } from "../src/entities";
import { createCompleteTalent, createRole, createTalent } from "./helpers/fixtures.js";
import { apiData } from "./helpers/http.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { createStaff, postStaff, staffBody, staffPath } from "./helpers/staff.js";
import { sendInviteEmail } from "../src/services/staffInvite.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => {
  const sendStaffInvite = jest.fn().mockResolvedValue(undefined);
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      sendWelcome: jest.fn().mockResolvedValue(undefined),
      sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
      sendCompanyInvite: jest.fn().mockResolvedValue(undefined),
      sendStaffInvite,
    })),
    sendStaffInvite,
  };
});

const sendStaffInvite = () =>
  (
    jest.requireMock("../src/utils/integrations/email/emailService.js") as {
      sendStaffInvite: jest.Mock<Promise<void>, [{ inviteLink: string }]>;
    }
  ).sendStaffInvite;

const tokenFromLastEmail = (): string => {
  const token = sendStaffInvite().mock.calls.at(-1)?.[0].inviteLink.split("/").pop();
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

const invite = (token: string, orgId: string, staffId: string) =>
  request(app)
    .post(staffPath(orgId, `/${staffId}/invite`))
    .set(authHeader(token))
    .send({});

const endStaff = (token: string, orgId: string, staffId: string) =>
  request(app)
    .post(staffPath(orgId, `/${staffId}/end`))
    .set(authHeader(token))
    .send({});

const accept = (token: string, inviteToken: string) =>
  request(app).post(`/v1/staff-invites/${inviteToken}/accept`).set(authHeader(token));

const expireCooldown = (staffId: string) =>
  testDataSource
    .getRepository(StaffMember)
    .update(staffId, { invitedAt: new Date(Date.now() - 5 * 60_000) });

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

async function invitedStaff(email = "invitee@example.com") {
  const company = await setupCompany();
  const hr = await addMember(company.org, { canManagePeople: true });
  const staff = await createStaff(app, hr.token, company.org.id, { email, sendInvite: true });
  return { ...company, hr, staff, inviteToken: tokenFromLastEmail() };
}

describe("an invite email that fails", () => {
  it("is still reported as failed when the failure itself cannot be recorded", async () => {
    const { owner, org } = await setupCompany();
    sendStaffInvite().mockRejectedValueOnce(new Error("provider down"));
    await testDataSource.query(
      `ALTER TABLE "staff_activities" ADD CONSTRAINT "CHK_test_no_invite_failed" CHECK ("type" <> 'invite_failed')`
    );
    try {
      const res = await postStaff(app, owner.token, org.id, { sendInvite: true });

      expect(res.status).toBe(201);
      expect(apiData<{ inviteEmailSent: boolean }>(res).inviteEmailSent).toBe(false);
    } finally {
      await testDataSource.query(
        `ALTER TABLE "staff_activities" DROP CONSTRAINT "CHK_test_no_invite_failed"`
      );
    }
  });

  it("is reported as failed when the same happens on a resend", async () => {
    const { org, hr, staff } = await invitedStaff();
    await expireCooldown(staff.id);
    sendStaffInvite().mockRejectedValueOnce(new Error("provider down"));
    await testDataSource.query(
      `ALTER TABLE "staff_activities" ADD CONSTRAINT "CHK_test_no_invite_failed" CHECK ("type" <> 'invite_failed')`
    );
    try {
      const res = await invite(hr.token, org.id, staff.id);

      expect(res.status).toBe(200);
      expect(apiData<{ inviteEmailSent: boolean }>(res).inviteEmailSent).toBe(false);
    } finally {
      await testDataSource.query(
        `ALTER TABLE "staff_activities" DROP CONSTRAINT "CHK_test_no_invite_failed"`
      );
    }
  });
});

describe("a stalled email provider", () => {
  const fakeOnlyTimeouts = () =>
    jest.useFakeTimers({
      doNotFake: [
        "nextTick",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "Date",
        "queueMicrotask",
        "performance",
        "hrtime",
      ],
    });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function loadRecord() {
    const { owner, org } = await setupCompany();
    const created = await createStaff(app, owner.token, org.id);
    return {
      owner,
      created,
      organization: await testDataSource
        .getRepository(Organization)
        .findOneByOrFail({ id: org.id }),
      record: await staffRow(created.id),
    };
  }

  it("is given up on and recorded as a failed invite instead of holding the request open", async () => {
    const { owner, created, organization, record } = await loadRecord();
    sendStaffInvite().mockImplementationOnce(() => new Promise<void>(() => undefined));

    fakeOnlyTimeouts();
    const pending = sendInviteEmail(organization, record, "a".repeat(64), owner.user);
    await jest.advanceTimersByTimeAsync(15_000);
    jest.useRealTimers();

    await expect(pending).resolves.toBe(false);
    expect(sendStaffInvite()).toHaveBeenCalledTimes(1);
    expect(await activityTypes(created.id)).toContain("invite_failed");
  }, 20_000);

  it("leaves no timer behind when the email goes out normally", async () => {
    const { owner, organization, record } = await loadRecord();

    fakeOnlyTimeouts();
    const before = jest.getTimerCount();
    await expect(sendInviteEmail(organization, record, "b".repeat(64), owner.user)).resolves.toBe(
      true
    );

    expect(jest.getTimerCount()).toBe(before);
  });
});

describe("previewing an invite when the open cannot be logged", () => {
  it("does not mark the invite opened, so the next visit still logs it", async () => {
    const { staff, inviteToken } = await invitedStaff();

    await testDataSource.query(`ALTER TABLE "staff_activities" RENAME TO "staff_activities_x"`);
    try {
      const res = await request(app).get(`/v1/staff-invites/${inviteToken}`);
      expect(res.status).toBe(500);
      expect((await staffRow(staff.id)).inviteOpenedAt).toBeNull();
    } finally {
      await testDataSource.query(`ALTER TABLE "staff_activities_x" RENAME TO "staff_activities"`);
    }

    const retry = await request(app).get(`/v1/staff-invites/${inviteToken}`);
    expect(retry.status).toBe(200);
    expect((await staffRow(staff.id)).inviteOpenedAt).not.toBeNull();
    expect((await activityTypes(staff.id)).filter((type) => type === "invite_opened")).toHaveLength(
      1
    );
  });

  it("logs the first open once when the link is opened several times at the same moment", async () => {
    const { staff, inviteToken } = await invitedStaff();

    const results = await Promise.all(
      Array.from({ length: 4 }, () => request(app).get(`/v1/staff-invites/${inviteToken}`))
    );

    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect((await activityTypes(staff.id)).filter((type) => type === "invite_opened")).toHaveLength(
      1
    );
  });
});

describe("a person with a very long name", () => {
  it("can still add and invite staff", async () => {
    const company = await setupCompany();
    const hr = await addMember(company.org, {
      canManagePeople: true,
      firstName: "A".repeat(150),
      lastName: "B".repeat(150),
    });

    const res = await postStaff(app, hr.token, company.org.id, { sendInvite: true });

    expect(res.status).toBe(201);
    expect(apiData<{ inviteEmailSent: boolean }>(res).inviteEmailSent).toBe(true);
  });
});

describe("hostile input is refused, not crashed on", () => {
  const NUL = "\u0000";
  const SOME_ID = "6f1c3d52-9b0e-4a53-8a31-2d4f7c9e1b10";

  it.each([
    ["full name", { fullName: `Ada${NUL}Obi` }],
    ["job title", { jobTitle: `Designer${NUL}` }],
    ["department", { department: `Design${NUL}` }],
  ])("refuses a NUL byte in the %s when adding and when editing", async (_label, bad) => {
    const { owner, org } = await setupCompany();
    const staff = await createStaff(app, owner.token, org.id);

    expect((await postStaff(app, owner.token, org.id, bad)).status).toBe(400);
    const edit = await request(app)
      .patch(staffPath(org.id, `/${staff.id}`))
      .set(authHeader(owner.token))
      .send(bad);
    expect(edit.status).toBe(400);
  });

  it.each([
    ["a NUL byte in search", "", "search=%00"],
    ["an offset beyond the database range", "", "offset=99999999999999999999"],
    ["a repeated limit", "", "limit=1&limit=2"],
    ["a repeated offset", "", "offset=1&offset=2"],
    ["a repeated status", "", "status=active&status=ended"],
    ["a repeated search", "", "search=a&search=b"],
    ["a repeated includeEnded", "/options", "includeEnded=true&includeEnded=false"],
    ["a repeated staffId", "/access-log", `staffId=${SOME_ID}&staffId=${SOME_ID}`],
    ["a repeated actorId", "/access-log", `actorId=${SOME_ID}&actorId=${SOME_ID}`],
    ["a repeated from date", "/access-log", "from=2026-01-01&from=2026-01-02"],
    ["a repeated to date", "/access-log", "to=2026-01-01&to=2026-01-02"],
    [
      "an access log offset beyond the database range",
      "/access-log",
      "offset=99999999999999999999",
    ],
  ])("answers 400 to %s", async (_label, suffix, query) => {
    const { owner, org } = await setupCompany();

    const res = await request(app)
      .get(`${staffPath(org.id, suffix)}?${query}`)
      .set(authHeader(owner.token));

    expect(res.status).toBe(400);
  });
});

describe("simultaneous requests", () => {
  it("lets exactly one of several identical adds create the person", async () => {
    const { owner, org } = await setupCompany();
    const body = staffBody({ email: "twin@example.com" });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post(staffPath(org.id)).set(authHeader(owner.token)).send(body)
      )
    );

    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(
      await testDataSource.getRepository(StaffMember).countBy({ organizationId: org.id })
    ).toBe(1);
  });

  it("sends one invite email when identical adds with an invite race", async () => {
    const { owner, org } = await setupCompany();
    const body = staffBody({ email: "twin@example.com", sendInvite: true });

    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(app).post(staffPath(org.id)).set(authHeader(owner.token)).send(body)
      )
    );

    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(sendStaffInvite()).toHaveBeenCalledTimes(1);
  });

  it("ends employment once when two people end the same record", async () => {
    const { owner, org } = await setupCompany();
    const staff = await createStaff(app, owner.token, org.id);

    const results = await Promise.all([
      endStaff(owner.token, org.id, staff.id),
      endStaff(owner.token, org.id, staff.id),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await activityTypes(staff.id)).toEqual(["created", "ended"]);
  });

  it("sends one resend when the button is pressed twice at once", async () => {
    const { org, hr, staff } = await invitedStaff();
    await expireCooldown(staff.id);
    sendStaffInvite().mockClear();

    const results = await Promise.all([
      invite(hr.token, org.id, staff.id),
      invite(hr.token, org.id, staff.id),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 429]);
    expect(sendStaffInvite()).toHaveBeenCalledTimes(1);
    expect((await staffRow(staff.id)).inviteTokenHash).toBe(sha256(tokenFromLastEmail()));
    expect(await activityTypes(staff.id)).toEqual(["created", "invited", "invite_resent"]);
  });

  it("joins once when the person clicks accept twice at once", async () => {
    const { staff, inviteToken } = await invitedStaff("full@example.com");
    const talent = await createCompleteTalent(await createRole(), { email: "full@example.com" });

    const results = await Promise.all([
      accept(talent.token, inviteToken),
      accept(talent.token, inviteToken),
    ]);

    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await activityTypes(staff.id)).toEqual(["created", "invited", "joined"]);
    expect((await staffRow(staff.id)).userId).toBe(talent.user.id);
  });

  it("leaves no live invite when a resend races the end of employment", async () => {
    const { org, hr, staff } = await invitedStaff();
    await expireCooldown(staff.id);

    const [resend, ended] = await Promise.all([
      invite(hr.token, org.id, staff.id),
      endStaff(hr.token, org.id, staff.id),
    ]);

    expect([200, 409]).toContain(resend.status);
    expect(ended.status).toBe(200);
    expect(await staffRow(staff.id)).toMatchObject({ status: "ended", inviteTokenHash: null });
  });

  it("never fails when a manager leaves while someone is being assigned to them", async () => {
    const { owner, org } = await setupCompany();
    const boss = await createStaff(app, owner.token, org.id, { fullName: "Bola Boss" });

    const [added, ended] = await Promise.all([
      postStaff(app, owner.token, org.id, { managerId: boss.id }),
      endStaff(owner.token, org.id, boss.id),
    ]);

    expect([201, 400]).toContain(added.status);
    expect(ended.status).toBe(200);
  });

  it("never fails when an edit races the end of the same record", async () => {
    const { owner, org } = await setupCompany();
    const staff = await createStaff(app, owner.token, org.id);

    const [edit, ended] = await Promise.all([
      request(app)
        .patch(staffPath(org.id, `/${staff.id}`))
        .set(authHeader(owner.token))
        .send({ jobTitle: "Lead Designer" }),
      endStaff(owner.token, org.id, staff.id),
    ]);

    expect([200, 409]).toContain(edit.status);
    expect(ended.status).toBe(200);
    expect(await staffRow(staff.id)).toMatchObject({ status: "ended" });
  });
});

describe("callers who should never get in", () => {
  const routes = (orgId: string, staffId: string): [string, "get" | "post" | "patch", string][] => [
    ["access", "get", staffPath(orgId, "/access")],
    ["list", "get", staffPath(orgId)],
    ["options", "get", staffPath(orgId, "/options")],
    ["access log", "get", staffPath(orgId, "/access-log")],
    ["add", "post", staffPath(orgId)],
    ["open", "get", staffPath(orgId, `/${staffId}`)],
    ["edit", "patch", staffPath(orgId, `/${staffId}`)],
    ["end", "post", staffPath(orgId, `/${staffId}/end`)],
    ["invite", "post", staffPath(orgId, `/${staffId}/invite`)],
    ["activity", "get", staffPath(orgId, `/${staffId}/activity`)],
  ];

  it("turns away callers with no token, a bad token or a talent token on every staff route", async () => {
    const { owner, org } = await setupCompany();
    const staff = await createStaff(app, owner.token, org.id);
    const talent = await createTalent();

    for (const [name, method, path] of routes(org.id, staff.id)) {
      const body = {
        jobTitle: "Hacker",
        fullName: "X",
        email: "x@example.com",
        startDate: "2026-01-01",
      };
      const anonymous = await request(app)[method](path).send(body);
      const garbage = await request(app)[method](path).set(authHeader("not-a-token")).send(body);
      const wrongRole = await request(app)[method](path).set(authHeader(talent.token)).send(body);

      expect([name, anonymous.status]).toEqual([name, 401]);
      expect([name, garbage.status]).toEqual([name, 401]);
      expect([name, wrongRole.status]).toEqual([name, 403]);
    }

    expect(await testDataSource.getRepository(StaffMember).count()).toBe(1);
    expect(await testDataSource.getRepository(StaffAccessLog).count()).toBe(0);
    expect((await staffRow(staff.id)).jobTitle).toBe("Product Designer");
    expect(sendStaffInvite()).not.toHaveBeenCalled();
  });

  it("lets only a talent account accept an invite, and only with a well-formed link", async () => {
    const { owner, inviteToken } = await invitedStaff("full@example.com");
    const talent = await createCompleteTalent(await createRole(), { email: "full@example.com" });

    expect((await request(app).post(`/v1/staff-invites/${inviteToken}/accept`)).status).toBe(401);
    expect((await accept(owner.token, inviteToken)).status).toBe(403);
    expect((await accept(talent.token, "not-a-token")).status).toBe(400);
    expect((await accept(talent.token, "f".repeat(64))).status).toBe(404);
    expect((await request(app).get("/v1/staff-invites/not-a-token")).status).toBe(400);
    expect((await request(app).get(`/v1/staff-invites/${"f".repeat(64)}`)).status).toBe(404);
  });

  it("does not show the staff view to the unauthenticated invite preview", async () => {
    const { inviteToken } = await invitedStaff("full@example.com");

    const res = await request(app).get(`/v1/staff-invites/${inviteToken}`);

    expect(res.status).toBe(200);
    expect(Object.keys(apiData<{ invite: Record<string, unknown> }>(res).invite).sort()).toEqual(
      [
        "expiresAt",
        "invitedByName",
        "invitedEmail",
        "inviteeExists",
        "jobTitle",
        "organizationLogoUrl",
        "organizationName",
        "status",
      ].sort()
    );
    expect(JSON.stringify(res.body)).not.toContain("tokenHash");
  });
});
