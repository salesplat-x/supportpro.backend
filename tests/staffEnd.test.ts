import request from "supertest";
import { createApp } from "../src/app.js";
import { StaffActivity, StaffActivityType } from "../src/entities/StaffActivity.js";
import { StaffMember, StaffStatus } from "../src/entities/StaffMember.js";
import { finalizeScheduledEndings } from "../src/services/staff.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { apiData } from "./helpers/http.js";
import { authHeader, setupCompany } from "./helpers/company.js";
import { createTalent } from "./helpers/fixtures.js";
import { createStaff, staffPath, today } from "./helpers/staff.js";

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
});

const daysFromToday = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const setup = async () => {
  const { owner, org } = await setupCompany();
  const staff = await createStaff(app, owner.token, org.id, { startDate: "2026-01-05" });
  const end = (body: Record<string, unknown>, id = staff.id) =>
    request(app)
      .post(staffPath(org.id, `/${id}/end`))
      .set(authHeader(owner.token))
      .send(body);
  return { owner, org, staff, end };
};

const stored = (id: string) => testDataSource.getRepository(StaffMember).findOneByOrFail({ id });

const activities = (staffId: string, type: StaffActivityType) =>
  testDataSource.getRepository(StaffActivity).find({ where: { staffId, type } });

describe("ending employment", () => {
  it("a date up to today ends it now and keeps the reason", async () => {
    const { staff, end } = await setup();

    const res = await end({ endDate: today(), reason: "resigned" }).expect(200);

    expect(apiData<{ staff: unknown }>(res).staff).toMatchObject({
      status: StaffStatus.Ended,
      endDate: today(),
      endingOn: null,
      endReason: "resigned",
    });
    const [entry] = await activities(staff.id, StaffActivityType.Ended);
    expect(entry?.meta).toEqual({ endDate: today(), reason: "resigned" });
  });

  it("a future date keeps the person active until that day", async () => {
    const { staff, end } = await setup();
    const lastDay = daysFromToday(11);

    const res = await end({ endDate: lastDay, reason: "contract_ended" }).expect(200);

    expect(apiData<{ staff: unknown }>(res).staff).toMatchObject({
      status: StaffStatus.Active,
      endDate: null,
      endingOn: lastDay,
      endReason: "contract_ended",
    });
    expect(await activities(staff.id, StaffActivityType.EndScheduled)).toHaveLength(1);
    expect(await activities(staff.id, StaffActivityType.Ended)).toHaveLength(0);
  });

  it("they keep My work until the day, and never see the reason", async () => {
    const { staff, end } = await setup();
    const talent = await createTalent();
    await testDataSource.getRepository(StaffMember).update(staff.id, { userId: talent.user.id });

    await end({ endDate: daysFromToday(5), reason: "dismissed" }).expect(200);

    const res = await request(app).get("/v1/my-work").set(authHeader(talent.token)).expect(200);
    const body = JSON.stringify(apiData(res));
    expect(body).toContain(staff.id);
    expect(body).not.toContain("dismissed");
    expect(body).not.toContain("endReason");
  });

  it("choosing a new future date replaces the old one", async () => {
    const { staff, end } = await setup();

    await end({ endDate: daysFromToday(5), reason: "resigned" }).expect(200);
    await end({ endDate: daysFromToday(9) }).expect(200);

    expect(await stored(staff.id)).toMatchObject({
      status: StaffStatus.Active,
      endingOn: daysFromToday(9),
      endReason: null,
    });
    const scheduled = await activities(staff.id, StaffActivityType.EndScheduled);
    expect(scheduled.map((a) => a.meta?.["previousEndDate"])).toContain(daysFromToday(5));
  });

  it("someone with a future date can still be ended today", async () => {
    const { staff, end } = await setup();
    await end({ endDate: daysFromToday(5) }).expect(200);

    await end({ endDate: today() }).expect(200);

    expect(await stored(staff.id)).toMatchObject({
      status: StaffStatus.Ended,
      endDate: today(),
      endingOn: null,
    });
  });

  it.each([
    ["an unknown reason", { endDate: today(), reason: "bored" }],
    ["a date before the start", { endDate: "2026-01-04" }],
    ["a date over a year away", { endDate: daysFromToday(367) }],
  ])("rejects %s → 400 and changes nothing", async (_label, body) => {
    const { staff, end } = await setup();

    await end(body).expect(400);

    expect(await stored(staff.id)).toMatchObject({
      status: StaffStatus.Active,
      endingOn: null,
      endReason: null,
    });
  });

  it("an ended employment can't be ended again → 409", async () => {
    const { end } = await setup();
    await end({ endDate: today() }).expect(200);

    await end({ endDate: today() }).expect(409);
  });
});

describe("finishing scheduled endings", () => {
  const scheduleInPast = async (id: string, endingOn = daysFromToday(-1)) =>
    testDataSource.getRepository(StaffMember).update(id, { endingOn });

  it("ends people whose last day has passed and leaves the rest", async () => {
    const { owner, org, staff, end } = await setup();
    const later = await createStaff(app, owner.token, org.id, { startDate: "2026-01-05" });
    const lastDayToday = await createStaff(app, owner.token, org.id, { startDate: "2026-01-05" });
    await end({ endDate: daysFromToday(3), reason: "retired" }).expect(200);
    await end({ endDate: daysFromToday(20) }, later.id).expect(200);
    await scheduleInPast(staff.id, "2026-06-30");
    await scheduleInPast(lastDayToday.id, today());

    expect(await finalizeScheduledEndings()).toBe(1);

    expect(await stored(staff.id)).toMatchObject({
      status: StaffStatus.Ended,
      endDate: "2026-06-30",
      endingOn: null,
      endReason: "retired",
      inviteTokenHash: null,
    });
    expect((await stored(later.id)).status).toBe(StaffStatus.Active);
    expect((await stored(lastDayToday.id)).status).toBe(StaffStatus.Active);
    const [entry] = await activities(staff.id, StaffActivityType.Ended);
    expect(entry).toMatchObject({ actorId: null, actorName: "AuxHR" });
  });

  it("running it again does nothing more", async () => {
    const { staff, end } = await setup();
    await end({ endDate: daysFromToday(3) }).expect(200);
    await scheduleInPast(staff.id);

    await finalizeScheduledEndings();
    expect(await finalizeScheduledEndings()).toBe(0);

    expect(await activities(staff.id, StaffActivityType.Ended)).toHaveLength(1);
  });

  it("two sweeps at once end each person once", async () => {
    const { owner, org, staff, end } = await setup();
    const other = await createStaff(app, owner.token, org.id, { startDate: "2026-01-05" });
    await end({ endDate: daysFromToday(3) }).expect(200);
    await end({ endDate: daysFromToday(3) }, other.id).expect(200);
    await scheduleInPast(staff.id);
    await scheduleInPast(other.id);

    const counts = await Promise.all([finalizeScheduledEndings(), finalizeScheduledEndings()]);

    expect(counts[0]! + counts[1]!).toBe(2);
    expect(await activities(staff.id, StaffActivityType.Ended)).toHaveLength(1);
    expect(await activities(other.id, StaffActivityType.Ended)).toHaveLength(1);
  });

  it("a sweep racing a manual end leaves one Ended entry and no error", async () => {
    const { staff, end } = await setup();
    await end({ endDate: daysFromToday(3) }).expect(200);
    await scheduleInPast(staff.id);

    const [, manual] = await Promise.all([finalizeScheduledEndings(), end({ endDate: today() })]);

    expect([200, 409]).toContain(manual.status);
    expect((await stored(staff.id)).status).toBe(StaffStatus.Ended);
    expect(await activities(staff.id, StaffActivityType.Ended)).toHaveLength(1);
  });

  it("an invited person whose last day passed is ended and their invite stops working", async () => {
    const { owner, org } = await setupCompany();
    const invited = await createStaff(app, owner.token, org.id, {
      startDate: "2026-01-05",
      sendInvite: true,
    });
    await request(app)
      .post(staffPath(org.id, `/${invited.id}/end`))
      .set(authHeader(owner.token))
      .send({ endDate: daysFromToday(3) })
      .expect(200);
    expect((await stored(invited.id)).inviteTokenHash).not.toBeNull();
    await scheduleInPast(invited.id);

    await finalizeScheduledEndings();

    expect(await stored(invited.id)).toMatchObject({
      status: StaffStatus.Ended,
      inviteTokenHash: null,
      inviteExpiresAt: null,
    });
  });
});
