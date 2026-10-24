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
