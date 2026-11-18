/**
 * Staff records — people access, CRUD, access log, activity log and company isolation.
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { OrganizationMember, StaffAccessLog, StaffActivity, StaffMember } from "../src/entities";
import { createOrganization, createRecruiter, createTalent } from "./helpers/fixtures.js";
import { apiData } from "./helpers/http.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import {
  createStaff,
  postStaff,
  staffBody,
  staffPath,
  today,
  type StaffViewShape,
} from "./helpers/staff.js";

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
      sendStaffInvite: jest.Mock;
    }
  ).sendStaffInvite;

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

const logsFor = (staffId: string) =>
  testDataSource.getRepository(StaffAccessLog).find({ where: { staffId } });

const activitiesFor = (staffId: string) =>
  testDataSource
    .getRepository(StaffActivity)
    .find({ where: { staffId }, order: { createdAt: "ASC" } });

describe("people access", () => {
  it("tells the owner they can manage people", async () => {
    const { owner, org } = await setupCompany();
    const res = await request(app).get(staffPath(org.id, "/access")).set(authHeader(owner.token));
    expect(res.status).toBe(200);
    expect(apiData<{ access: unknown }>(res).access).toEqual({
      isOwner: true,
      canManagePeople: true,
      assignedCount: 0,
    });
  });

  it("lets a member with the setting use the staff routes", async () => {
    const { org } = await setupCompany();
    const hr = await addMember(org, { canManagePeople: true });

    const access = await request(app).get(staffPath(org.id, "/access")).set(authHeader(hr.token));
    expect(apiData<{ access: unknown }>(access).access).toEqual({
      isOwner: false,
      canManagePeople: true,
      assignedCount: 0,
    });
    const list = await request(app).get(staffPath(org.id)).set(authHeader(hr.token));
    expect(list.status).toBe(200);
  });

  it("refuses a member without the setting on every staff route", async () => {
    const { owner, org } = await setupCompany();
    const plain = await addMember(org, { canManagePeople: false });
    const staff = await createStaff(app, owner.token, org.id);
    const h = authHeader(plain.token);

    const access = await request(app).get(staffPath(org.id, "/access")).set(h);
    expect(apiData<{ access: unknown }>(access).access).toEqual({
      isOwner: false,
      canManagePeople: false,
      assignedCount: 0,
    });

    const responses = await Promise.all([
      request(app).get(staffPath(org.id)).set(h),
      request(app).get(staffPath(org.id, "/options")).set(h),
      request(app).post(staffPath(org.id)).set(h).send(staffBody()),
      request(app)
        .get(staffPath(org.id, `/${staff.id}`))
        .set(h),
      request(app)
        .patch(staffPath(org.id, `/${staff.id}`))
        .set(h)
        .send({ jobTitle: "X" }),
      request(app)
        .post(staffPath(org.id, `/${staff.id}/end`))
        .set(h)
        .send({}),
      request(app)
        .post(staffPath(org.id, `/${staff.id}/invite`))
        .set(h)
        .send({}),
      request(app)
        .get(staffPath(org.id, `/${staff.id}/activity`))
        .set(h),
      request(app).get(staffPath(org.id, "/access-log")).set(h),
    ]);
    expect(responses.map((r) => r.status)).toEqual(Array(responses.length).fill(403));
    expect(await testDataSource.getRepository(StaffAccessLog).count()).toBe(0);
  });

  it("refuses a recruiter who is not in the company", async () => {
    const { org } = await setupCompany();
    const outsider = await createRecruiter();
    const access = await request(app)
      .get(staffPath(org.id, "/access"))
      .set(authHeader(outsider.token));
    const list = await request(app).get(staffPath(org.id)).set(authHeader(outsider.token));
    expect([access.status, list.status]).toEqual([403, 403]);
  });

  it("does not carry a member's setting from one company to another", async () => {
    const { org } = await setupCompany("Acme Ltd");
    const other = await setupCompany("Globex Ltd");
    const hr = await addMember(org, { canManagePeople: true });
    const res = await request(app).get(staffPath(other.org.id)).set(authHeader(hr.token));
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown company and 400 for a malformed id", async () => {
    const { owner } = await setupCompany();
    const unknown = await request(app)
      .get(staffPath("00000000-0000-4000-8000-000000000000"))
      .set(authHeader(owner.token));
    const malformed = await request(app).get(staffPath("not-a-uuid")).set(authHeader(owner.token));
    expect([unknown.status, malformed.status]).toEqual([404, 400]);
  });

  it("cuts access on the next request when the setting is switched off", async () => {
    const { owner, org } = await setupCompany();
    const hr = await addMember(org, { canManagePeople: true });
    expect((await request(app).get(staffPath(org.id)).set(authHeader(hr.token))).status).toBe(200);

    const off = await request(app)
      .patch(`/v1/organizations/${org.id}/members/${hr.memberId}`)
      .set(authHeader(owner.token))
      .send({ canManagePeople: false });
    expect(off.status).toBe(200);

    expect((await request(app).get(staffPath(org.id)).set(authHeader(hr.token))).status).toBe(403);
  });
});

describe("adding staff", () => {
  it("adds a person hired outside AuxHR as active, with no email", async () => {
    const { owner, org } = await setupCompany();
    const res = await postStaff(app, owner.token, org.id, { email: "ada@example.com" });

    expect(res.status).toBe(201);
    const { staff, inviteEmailSent } = apiData<{
      staff: StaffViewShape;
      inviteEmailSent: boolean | null;
    }>(res);
    expect(staff).toMatchObject({
      fullName: "Ada Obi",
      email: "ada@example.com",
      jobTitle: "Product Designer",
      department: "Design",
      status: "active",
      hiredThroughAuxhr: false,
      isExecutive: false,
      hasAccount: false,
      managerId: null,
      endDate: null,
    });
    expect(staff.invite.state).toBe("none");
    expect(inviteEmailSent).toBeNull();
    expect(sendStaffInvite()).not.toHaveBeenCalled();

    const activities = await activitiesFor(staff.id);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ type: "created", actorName: "Olu Owner" });
  });

  it("ignores fields the client must not control", async () => {
    const { owner, org } = await setupCompany();
    const res = await postStaff(app, owner.token, org.id, {
      status: "ended",
      userId: owner.user.id,
      hiredThroughAuxhr: true,
      invitedByName: "Someone Else",
      endDate: "2026-02-01",
    });
    expect(res.status).toBe(201);
    const row = await testDataSource
      .getRepository(StaffMember)
      .findOneByOrFail({ id: apiData<{ staff: StaffViewShape }>(res).staff.id });
    expect(row).toMatchObject({
      status: "active",
      userId: null,
      hiredThroughAuxhr: false,
      invitedByName: null,
      endDate: null,
    });
  });

  it("rejects invalid input", async () => {
    const { owner, org } = await setupCompany();
    const bad = async (overrides: Record<string, unknown>) =>
      (await postStaff(app, owner.token, org.id, overrides)).status;

    expect(await bad({ fullName: "" })).toBe(400);
    expect(await bad({ fullName: "Ada\r\nBcc: spam@example.com" })).toBe(400);
    expect(await bad({ fullName: "A".repeat(121) })).toBe(400);
    expect(await bad({ email: "not-an-email" })).toBe(400);
    expect(await bad({ jobTitle: "" })).toBe(400);
    expect(await bad({ startDate: "05/01/2026" })).toBe(400);
    expect(await bad({ startDate: "2026-02-31" })).toBe(400);
    expect(await bad({ startDate: "1850-01-01" })).toBe(400);
    expect(await bad({ startDate: "2300-01-01" })).toBe(400);
    expect(await bad({ managerId: "not-a-uuid" })).toBe(400);
  });

  it("refuses a second open record with the same email, including a Gmail dot variant", async () => {
    const { owner, org } = await setupCompany();
    await createStaff(app, owner.token, org.id, { email: "john.doe@gmail.com" });
    const same = await postStaff(app, owner.token, org.id, { email: "john.doe@gmail.com" });
    const dotless = await postStaff(app, owner.token, org.id, { email: "johndoe@gmail.com" });
    expect([same.status, dotless.status]).toEqual([409, 409]);
  });

  it("lets two companies hold the same email, and the same company re-add after the record ended", async () => {
    const { owner, org } = await setupCompany();
    const other = await setupCompany("Globex Ltd");
    const first = await createStaff(app, owner.token, org.id, { email: "shared@example.com" });
    await createStaff(app, other.owner.token, other.org.id, { email: "shared@example.com" });

    await request(app)
      .post(staffPath(org.id, `/${first.id}/end`))
      .set(authHeader(owner.token))
      .send({});
    const again = await postStaff(app, owner.token, org.id, { email: "shared@example.com" });
    expect(again.status).toBe(201);
  });
});

describe("managers", () => {
  it("records the manager and shows their name", async () => {
    const { owner, org } = await setupCompany();
    const boss = await createStaff(app, owner.token, org.id, { fullName: "Bola Boss" });
    const report = await createStaff(app, owner.token, org.id, { managerId: boss.id });
    expect(report.managerId).toBe(boss.id);
    expect(report.managerName).toBe("Bola Boss");
  });

  it("refuses a manager from another company, an unknown one and an ended one", async () => {
    const { owner, org } = await setupCompany();
    const other = await setupCompany("Globex Ltd");
    const foreign = await createStaff(app, other.owner.token, other.org.id);
    const gone = await createStaff(app, owner.token, org.id);
    await request(app)
      .post(staffPath(org.id, `/${gone.id}/end`))
      .set(authHeader(owner.token))
      .send({});

    const withManager = async (managerId: string) =>
      (await postStaff(app, owner.token, org.id, { managerId })).status;
    expect(await withManager(foreign.id)).toBe(400);
    expect(await withManager("00000000-0000-4000-8000-000000000000")).toBe(400);
    expect(await withManager(gone.id)).toBe(400);
  });

  it("refuses someone managing themselves or a reporting loop", async () => {
    const { owner, org } = await setupCompany();
    const a = await createStaff(app, owner.token, org.id, { fullName: "A" });
    const b = await createStaff(app, owner.token, org.id, { fullName: "B", managerId: a.id });
    const c = await createStaff(app, owner.token, org.id, { fullName: "C", managerId: b.id });
    const setManager = (id: string, managerId: string) =>
      request(app)
        .patch(staffPath(org.id, `/${id}`))
        .set(authHeader(owner.token))
        .send({ managerId });

    expect((await setManager(a.id, a.id)).status).toBe(400);
    expect((await setManager(a.id, c.id)).status).toBe(400);
  });

  it("lists only people who are still employed as possible managers", async () => {
    const { owner, org } = await setupCompany();
    const stays = await createStaff(app, owner.token, org.id, { fullName: "Stays" });
    const leaves = await createStaff(app, owner.token, org.id, { fullName: "Leaves" });
    await request(app)
      .post(staffPath(org.id, `/${leaves.id}/end`))
      .set(authHeader(owner.token))
      .send({});

    const res = await request(app).get(staffPath(org.id, "/options")).set(authHeader(owner.token));
    const options = apiData<{ options: { id: string; status: string }[] }>(res).options;
    expect(options.map((o) => [o.id, o.status])).toEqual([[stays.id, "active"]]);
  });

  it("can include people who have left, for filters that must reach everyone", async () => {
    const { owner, org } = await setupCompany();
    const stays = await createStaff(app, owner.token, org.id, { fullName: "Stays" });
    const leaves = await createStaff(app, owner.token, org.id, { fullName: "Leaves" });
    await request(app)
      .post(staffPath(org.id, `/${leaves.id}/end`))
      .set(authHeader(owner.token))
      .send({});

    const res = await request(app)
      .get(staffPath(org.id, "/options"))
      .query({ includeEnded: true })
      .set(authHeader(owner.token));
    const options = apiData<{ options: { id: string }[] }>(res).options;
    expect(options.map((o) => o.id).sort()).toEqual([stays.id, leaves.id].sort());

    const bad = await request(app)
      .get(staffPath(org.id, "/options"))
      .query({ includeEnded: "maybe" })
      .set(authHeader(owner.token));
    expect(bad.status).toBe(400);
  });

  it("lets only one of two simultaneous edits win when together they would form a loop", async () => {
    const { owner, org } = await setupCompany();
    const a = await createStaff(app, owner.token, org.id, { fullName: "A" });
    const b = await createStaff(app, owner.token, org.id, { fullName: "B" });
    const setManager = (id: string, managerId: string) =>
      request(app)
        .patch(staffPath(org.id, `/${id}`))
        .set(authHeader(owner.token))
        .send({ managerId });

    const [first, second] = await Promise.all([setManager(a.id, b.id), setManager(b.id, a.id)]);
    expect([first.status, second.status].sort()).toEqual([200, 400]);
  });

  it("still saves edits to someone whose manager has since left", async () => {
    const { owner, org } = await setupCompany();
    const boss = await createStaff(app, owner.token, org.id, { fullName: "Bola Boss" });
    const report = await createStaff(app, owner.token, org.id, { managerId: boss.id });
    await request(app)
      .post(staffPath(org.id, `/${boss.id}/end`))
      .set(authHeader(owner.token))
      .send({});

    const res = await request(app)
      .patch(staffPath(org.id, `/${report.id}`))
      .set(authHeader(owner.token))
      .send({ jobTitle: "Lead Designer", managerId: boss.id });
    expect(res.status).toBe(200);
    expect(apiData<{ staff: StaffViewShape }>(res).staff).toMatchObject({
      jobTitle: "Lead Designer",
      managerId: boss.id,
    });
  });
});

describe("listing staff", () => {
  it("lists newest first with the manager's name, a total and company-wide status counts", async () => {
    const { owner, org } = await setupCompany();
    const boss = await createStaff(app, owner.token, org.id, { fullName: "Bola Boss" });
    await createStaff(app, owner.token, org.id, { fullName: "Chidi", managerId: boss.id });
    const ended = await createStaff(app, owner.token, org.id, { fullName: "Dayo" });
    await request(app)
      .post(staffPath(org.id, `/${ended.id}/end`))
      .set(authHeader(owner.token))
      .send({});
    await createStaff(app, owner.token, org.id, { fullName: "Efe", sendInvite: true });

    const res = await request(app).get(staffPath(org.id)).set(authHeader(owner.token));
    const data = apiData<{
      items: StaffViewShape[];
      total: number;
      counts: Record<string, number>;
    }>(res);
    expect(data.total).toBe(4);
    expect(data.items.map((s) => s.fullName)).toEqual(["Efe", "Dayo", "Chidi", "Bola Boss"]);
    expect(data.items.find((s) => s.fullName === "Chidi")?.managerName).toBe("Bola Boss");
    expect(data.counts).toEqual({ invited: 1, active: 2, ended: 1 });
  });

  it("searches name, email, title and department, and treats % and _ literally", async () => {
    const { owner, org } = await setupCompany();
    await createStaff(app, owner.token, org.id, { fullName: "Ada Obi", email: "ada@example.com" });
    await createStaff(app, owner.token, org.id, {
      fullName: "Bayo Eze",
      jobTitle: "Accountant",
      department: "Finance",
    });
    const search = async (q: string) => {
      const res = await request(app)
        .get(staffPath(org.id))
        .query({ search: q })
        .set(authHeader(owner.token));
      return apiData<{ items: StaffViewShape[] }>(res).items.map((s) => s.fullName);
    };

    expect(await search("ada")).toEqual(["Ada Obi"]);
    expect(await search("account")).toEqual(["Bayo Eze"]);
    expect(await search("finance")).toEqual(["Bayo Eze"]);
    expect(await search("%")).toEqual([]);
    expect(await search("a_a")).toEqual([]);
  });

  it("filters by status and paginates with a capped limit", async () => {
    const { owner, org } = await setupCompany();
    await createStaff(app, owner.token, org.id, { fullName: "One" });
    await createStaff(app, owner.token, org.id, { fullName: "Two" });
    await createStaff(app, owner.token, org.id, { fullName: "Three", sendInvite: true });
    const get = (query: Record<string, unknown>) =>
      request(app).get(staffPath(org.id)).query(query).set(authHeader(owner.token));

    const invited = apiData<{ items: StaffViewShape[]; total: number }>(
      await get({ status: "invited" })
    );
    expect(invited.items.map((s) => s.fullName)).toEqual(["Three"]);

    const page = apiData<{ items: StaffViewShape[]; total: number }>(
      await get({ limit: 1, offset: 1 })
    );
    expect(page.total).toBe(3);
    expect(page.items.map((s) => s.fullName)).toEqual(["Two"]);

    expect((await get({ limit: 101 })).status).toBe(400);
    expect((await get({ status: "bogus" })).status).toBe(400);
    expect((await get({ offset: -1 })).status).toBe(400);
  });

  it("does not write access-log lines for the list", async () => {
    const { owner, org } = await setupCompany();
    await createStaff(app, owner.token, org.id);
    await request(app).get(staffPath(org.id)).set(authHeader(owner.token));
    expect(await testDataSource.getRepository(StaffAccessLog).count()).toBe(0);
  });
});

describe("changing staff", () => {
  it("updates allowed fields and records what changed", async () => {
    const { owner, org } = await setupCompany();
    const staff = await createStaff(app, owner.token, org.id);
    const res = await request(app)
      .patch(staffPath(org.id, `/${staff.id}`))
      .set(authHeader(owner.token))
      .send({
        jobTitle: "Senior Designer",
        department: "",
        isExecutive: true,
        startDate: "2026-02-02",
      });

    expect(res.status).toBe(200);
    expect(apiData<{ staff: StaffViewShape }>(res).staff).toMatchObject({
      jobTitle: "Senior Designer",
      department: null,
      isExecutive: true,
      startDate: "2026-02-02",
    });
    const updated = (await activitiesFor(staff.id)).find((a) => a.type === "updated");
    expect(updated?.actorName).toBe("Olu Owner");
    expect(updated?.meta).toEqual({
      changes: {
        jobTitle: ["Product Designer", "Senior Designer"],
        department: ["Design", null],
        isExecutive: [false, true],
        startDate: ["2026-01-05", "2026-02-02"],
      },
    });
  });

  it("ignores status, account and hired-through in the body", async () => {
    const { owner, org } = await setupCompany();
    const staff = await createStaff(app, owner.token, org.id, { email: "fixed@example.com" });
    await request(app)
      .patch(staffPath(org.id, `/${staff.id}`))
      .set(authHeader(owner.token))
      .send({
        status: "ended",
        userId: owner.user.id,
        hiredThroughAuxhr: true,
        organizationId: "00000000-0000-4000-8000-000000000000",
      });

    const row = await testDataSource.getRepository(StaffMember).findOneByOrFail({ id: staff.id });
    expect(row).toMatchObject({
      status: "active",
      userId: null,
      email: "fixed@example.com",
      hiredThroughAuxhr: false,
      organizationId: org.id,
    });
    expect((await activitiesFor(staff.id)).map((a) => a.type)).toEqual(["created"]);
  });

  it("saves a phone and home address, and clears them again", async () => {
    const { owner, org } = await setupCompany();
    const staff = await createStaff(app, owner.token, org.id, { phone: "+2348035550198" });
    expect(staff).toMatchObject({ phone: "+2348035550198", homeAddress: null });

    const patch = (body: Record<string, unknown>) =>
      request(app)
        .patch(staffPath(org.id, `/${staff.id}`))
        .set(authHeader(owner.token))
        .send(body);

    const saved = await patch({ homeAddress: " 12 Akin Adesola St, Lagos " });
    expect(apiData<{ staff: StaffViewShape }>(saved).staff).toMatchObject({
      homeAddress: "12 Akin Adesola St, Lagos",
    });
    expect((await patch({ phone: "not a phone" })).status).toBe(400);
    expect((await patch({ homeAddress: "x".repeat(301) })).status).toBe(400);

    const cleared = await patch({ phone: "", homeAddress: null });
    expect(apiData<{ staff: StaffViewShape }>(cleared).staff).toMatchObject({
      phone: null,
      homeAddress: null,
    });
    const updates = (await activitiesFor(staff.id)).filter((a) => a.type === "updated");
    expect(updates.at(-1)?.meta).toEqual({
      changes: {
        phone: ["+2348035550198", null],
        homeAddress: ["12 Akin Adesola St, Lagos", null],
      },
    });
  });

  it("changes the email of someone who has not joined and kills the link sent to the old one", async () => {
    const { owner, org } = await setupCompany();
    const staff = await createStaff(app, owner.token, org.id, {
      email: "old@example.com",
      sendInvite: true,
    });
    const oldLink = (sendStaffInvite().mock.calls.at(-1)?.[0] as { inviteLink: string }).inviteLink;
    const oldToken = oldLink.split("/").pop()!;

    const res = await request(app)
      .patch(staffPath(org.id, `/${staff.id}`))
      .set(authHeader(owner.token))
      .send({ email: "New.Person@Example.com" });
    expect(res.status).toBe(200);
    expect(apiData<{ staff: StaffViewShape }>(res).staff.email).toBe("new.person@example.com");

    const row = await testDataSource.getRepository(StaffMember).findOneByOrFail({ id: staff.id });
    expect(row).toMatchObject({ inviteTokenHash: null, inviteExpiresAt: null, invitedAt: null });
    expect((await request(app).get(`/v1/staff-invites/${oldToken}`)).status).toBe(404);

    const resend = await request(app)
      .post(staffPath(org.id, `/${staff.id}/invite`))
      .set(authHeader(owner.token));
    expect(resend.status).toBe(200);
    expect(sendStaffInvite().mock.calls.at(-1)?.[0]).toMatchObject({
      email: "new.person@example.com",
    });
  });

  it("refuses an email another open record uses, and any email change after joining", async () => {
    const { owner, org } = await setupCompany();
    await createStaff(app, owner.token, org.id, { email: "taken@example.com" });
    const staff = await createStaff(app, owner.token, org.id, { email: "mine@example.com" });
    const patch = (email: string) =>
      request(app)
        .patch(staffPath(org.id, `/${staff.id}`))
        .set(authHeader(owner.token))
        .send({ email });

    expect((await patch("taken@example.com")).status).toBe(409);
    expect((await patch("not-an-email")).status).toBe(400);

    const talent = await createTalent({ email: "mine@example.com" });
    await testDataSource
      .getRepository(StaffMember)
      .update(staff.id, { userId: talent.user.id, joinedAt: new Date() });
    expect((await patch("other@example.com")).status).toBe(409);
    const row = await testDataSource.getRepository(StaffMember).findOneByOrFail({ id: staff.id });
    expect(row.email).toBe("mine@example.com");
  });

  it("writes no activity when nothing changed", async () => {
    const { owner, org } = await setupCompany();
    const staff = await createStaff(app, owner.token, org.id);
    await request(app)
      .patch(staffPath(org.id, `/${staff.id}`))
      .set(authHeader(owner.token))
      .send({ jobTitle: staff.jobTitle });
    expect((await activitiesFor(staff.id)).map((a) => a.type)).toEqual(["created"]);
  });
});

describe("ending staff", () => {
  it("ends employment today by default and then makes the record read-only", async () => {
    const { owner, org } = await setupCompany();
    const staff = await createStaff(app, owner.token, org.id);
    const res = await request(app)
      .post(staffPath(org.id, `/${staff.id}/end`))
      .set(authHeader(owner.token))
      .send({});

    expect(res.status).toBe(200);
    expect(apiData<{ staff: StaffViewShape }>(res).staff).toMatchObject({
      status: "ended",
      endDate: today(),
    });
    const ended = (await activitiesFor(staff.id)).find((a) => a.type === "ended");
    expect(ended?.actorName).toBe("Olu Owner");

    const again = await request(app)
      .post(staffPath(org.id, `/${staff.id}/end`))
      .set(authHeader(owner.token))
      .send({});
    const edit = await request(app)
      .patch(staffPath(org.id, `/${staff.id}`))
      .set(authHeader(owner.token))
      .send({ jobTitle: "Nope" });
    expect([again.status, edit.status]).toEqual([409, 409]);
  });

  it("accepts a past end date and refuses one before the start or over a year away", async () => {
    const { owner, org } = await setupCompany();
    const end = (id: string, endDate: string) =>
      request(app)
        .post(staffPath(org.id, `/${id}/end`))
        .set(authHeader(owner.token))
        .send({ endDate });
    const a = await createStaff(app, owner.token, org.id, { startDate: "2026-01-05" });
    const b = await createStaff(app, owner.token, org.id, { startDate: "2026-01-05" });
    const c = await createStaff(app, owner.token, org.id, { startDate: "2026-01-05" });
    const tooFar = new Date(Date.now() + 367 * 86_400_000).toISOString().slice(0, 10);

    expect((await end(a.id, "2026-03-01")).status).toBe(200);
    expect((await end(b.id, "2026-01-04")).status).toBe(400);
    expect((await end(c.id, tooFar)).status).toBe(400);
    expect((await end(c.id, "2026-13-01")).status).toBe(400);
  });
});

describe("access log", () => {
  it("writes exactly one line for each time a record is opened, with the viewer's real IP", async () => {
    const { owner, org } = await setupCompany();
    const hr = await addMember(org, { canManagePeople: true });
    const staff = await createStaff(app, owner.token, org.id, { fullName: "Ada Obi" });

    const open = (token: string, ip: string) =>
      request(app)
        .get(staffPath(org.id, `/${staff.id}`))
        .set(authHeader(token))
        .set("CF-Connecting-IP", ip);

    expect((await open(hr.token, "203.0.113.9")).status).toBe(200);
    let logs = await logsFor(staff.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      organizationId: org.id,
      actorId: hr.user.id,
      actorName: "Hana Resources",
      staffName: "Ada Obi",
      resource: "staff_record",
      ip: "203.0.113.9",
    });

    await open(owner.token, "198.51.100.4");
    logs = await logsFor(staff.id);
    expect(logs).toHaveLength(2);
  });

  it("writes one line when the activity is opened and none for a refused request", async () => {
    const { owner, org } = await setupCompany();
    const plain = await addMember(org);
    const staff = await createStaff(app, owner.token, org.id);

    await request(app)
      .get(staffPath(org.id, `/${staff.id}/activity`))
      .set(authHeader(plain.token));
    expect(await logsFor(staff.id)).toHaveLength(0);

    await request(app)
      .get(staffPath(org.id, `/${staff.id}/activity`))
      .set(authHeader(owner.token));
    const logs = await logsFor(staff.id);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.resource).toBe("staff_activity");
  });

  it("returns no data when the log line cannot be written", async () => {
    const { owner, org } = await setupCompany();
    const staff = await createStaff(app, owner.token, org.id);

    await testDataSource.query(`ALTER TABLE "staff_access_logs" RENAME TO "staff_access_logs_x"`);
    try {
      const res = await request(app)
        .get(staffPath(org.id, `/${staff.id}`))
        .set(authHeader(owner.token));
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain("Product Designer");
    } finally {
      await testDataSource.query(`ALTER TABLE "staff_access_logs_x" RENAME TO "staff_access_logs"`);
    }
  });

  it("is readable by the owner only, as readable lines", async () => {
    const { owner, org } = await setupCompany();
    const hr = await addMember(org, { canManagePeople: true });
    const staff = await createStaff(app, owner.token, org.id, { fullName: "Ada Obi" });
    await request(app)
      .get(staffPath(org.id, `/${staff.id}`))
      .set(authHeader(hr.token));

    const byHr = await request(app).get(staffPath(org.id, "/access-log")).set(authHeader(hr.token));
    expect(byHr.status).toBe(403);

    const res = await request(app)
      .get(staffPath(org.id, "/access-log"))
      .set(authHeader(owner.token));
    expect(res.status).toBe(200);
    const data = apiData<{
      items: { actorName: string; description: string; ip: string | null }[];
      total: number;
    }>(res);
    expect(data.total).toBe(1);
    expect(data.items[0]).toMatchObject({
      actorName: "Hana Resources",
      description: "Staff record of Ada Obi",
    });
  });

  it("filters by person and by date, counting the whole of the last day", async () => {
    const { owner, org } = await setupCompany();
    const hr = await addMember(org, { canManagePeople: true });
    const ada = await createStaff(app, owner.token, org.id, { fullName: "Ada Obi" });
    const bayo = await createStaff(app, owner.token, org.id, { fullName: "Bayo Eze" });
    const repo = testDataSource.getRepository(StaffAccessLog);
    const line = (staffId: string, staffName: string, at: Date, actorId: string, name: string) =>
      repo.save(
        repo.create({
          organizationId: org.id,
          actorId,
          actorName: name,
          staffId,
          staffName,
          resource: "staff_record" as StaffAccessLog["resource"],
          ip: "203.0.113.1",
          createdAt: at,
        })
      );
    await line(ada.id, "Ada Obi", new Date(2026, 2, 10, 23, 30), hr.user.id, "Hana Resources");
    await line(ada.id, "Ada Obi", new Date(2026, 2, 12, 9, 0), owner.user.id, "Olu Owner");
    await line(bayo.id, "Bayo Eze", new Date(2026, 2, 11, 10, 0), hr.user.id, "Hana Resources");

    const get = async (query: Record<string, string>) => {
      const res = await request(app)
        .get(staffPath(org.id, "/access-log"))
        .query(query)
        .set(authHeader(owner.token));
      return apiData<{ items: { staffName: string; actorName: string }[]; total: number }>(res);
    };

    expect((await get({ staffId: bayo.id })).items.map((i) => i.staffName)).toEqual(["Bayo Eze"]);
    expect((await get({ actorId: owner.user.id })).total).toBe(1);
    expect((await get({ from: "2026-03-10", to: "2026-03-10" })).total).toBe(1);
    expect((await get({ from: "2026-03-11" })).total).toBe(2);
    expect((await get({ to: "2026-03-11" })).total).toBe(2);
    const bad = await request(app)
      .get(staffPath(org.id, "/access-log"))
      .query({ staffId: "nope" })
      .set(authHeader(owner.token));
    expect(bad.status).toBe(400);
  });
});

describe("activity log", () => {
  it("lists what happened to a person, newest first, with who did each thing", async () => {
    const { owner, org } = await setupCompany();
    const hr = await addMember(org, { canManagePeople: true });
    const staff = await createStaff(app, hr.token, org.id, { sendInvite: true });
    await request(app)
      .patch(staffPath(org.id, `/${staff.id}`))
      .set(authHeader(owner.token))
      .send({ jobTitle: "Lead Designer" });
    await request(app)
      .post(staffPath(org.id, `/${staff.id}/end`))
      .set(authHeader(owner.token))
      .send({});

    const res = await request(app)
      .get(staffPath(org.id, `/${staff.id}/activity`))
      .set(authHeader(owner.token));
    expect(res.status).toBe(200);
    const activities = apiData<{
      activities: { type: string; actorName: string; meta: unknown }[];
    }>(res).activities;
    expect(activities.map((a) => [a.type, a.actorName])).toEqual([
      ["ended", "Olu Owner"],
      ["updated", "Olu Owner"],
      ["invited", "Hana Resources"],
      ["created", "Hana Resources"],
    ]);
  });
});

describe("company isolation", () => {
  it("keeps one company's records out of another's reach", async () => {
    const a = await setupCompany("Acme Ltd");
    const b = await setupCompany("Globex Ltd");
    const staff = await createStaff(app, a.owner.token, a.org.id);
    const hb = authHeader(b.owner.token);

    const viaOwnCompany = await Promise.all([
      request(app)
        .get(staffPath(b.org.id, `/${staff.id}`))
        .set(hb),
      request(app)
        .patch(staffPath(b.org.id, `/${staff.id}`))
        .set(hb)
        .send({ jobTitle: "X" }),
      request(app)
        .post(staffPath(b.org.id, `/${staff.id}/end`))
        .set(hb)
        .send({}),
      request(app)
        .post(staffPath(b.org.id, `/${staff.id}/invite`))
        .set(hb)
        .send({}),
      request(app)
        .get(staffPath(b.org.id, `/${staff.id}/activity`))
        .set(hb),
    ]);
    expect(viaOwnCompany.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);

    const viaTheirCompany = await Promise.all([
      request(app).get(staffPath(a.org.id)).set(hb),
      request(app)
        .get(staffPath(a.org.id, `/${staff.id}`))
        .set(hb),
      request(app).get(staffPath(a.org.id, "/access-log")).set(hb),
    ]);
    expect(viaTheirCompany.map((r) => r.status)).toEqual([403, 403, 403]);

    const ownList = await request(app).get(staffPath(b.org.id)).set(hb);
    expect(apiData<{ total: number }>(ownList).total).toBe(0);
    expect(await testDataSource.getRepository(StaffAccessLog).count()).toBe(0);
  });

  it("keeps a second company owned by the same person separate", async () => {
    const owner = await createRecruiter();
    const first = await createOrganization(owner.user, { name: "First Ltd" });
    const second = await createOrganization(owner.user, { name: "Second Ltd" });
    await createStaff(app, owner.token, first.id);

    const firstList = await request(app).get(staffPath(first.id)).set(authHeader(owner.token));
    const secondList = await request(app).get(staffPath(second.id)).set(authHeader(owner.token));
    expect(apiData<{ total: number }>(firstList).total).toBe(1);
    expect(apiData<{ total: number }>(secondList).total).toBe(0);
  });
});

describe("database guarantees", () => {
  it("rejects an ended record without an end date, and an end date without ending", async () => {
    const { owner, org } = await setupCompany();
    const staff = await createStaff(app, owner.token, org.id);
    const repo = testDataSource.getRepository(StaffMember);

    await expect(repo.update(staff.id, { status: "ended" as never })).rejects.toThrow();
    await expect(repo.update(staff.id, { endDate: "2026-02-01" })).rejects.toThrow();
  });

  it("rejects an ended record that still holds a live invite", async () => {
    const { owner, org } = await setupCompany();
    const staff = await createStaff(app, owner.token, org.id, { sendInvite: true });

    await expect(
      testDataSource
        .getRepository(StaffMember)
        .update(staff.id, { status: "ended" as never, endDate: "2026-02-01" })
    ).rejects.toThrow();
  });
});
