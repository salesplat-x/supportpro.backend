import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { StaffAccessLog, StaffActivity, StaffMember, StaffWeeklyReport } from "../src/entities";
import { addDays, isWeekOpen, weekStartOf, workToday } from "../src/utils/workCalendar.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { staffPath, today } from "./helpers/staff.js";
import { companyWithTeam, employee, endStaff } from "./helpers/team.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  weeklyAdvice: jest.fn(),
}));

const adviceMock = () =>
  (jest.requireMock("../src/utils/integrations/openai.js") as { weeklyAdvice: jest.Mock })
    .weeklyAdvice;

const aiReply = (content: unknown) => ({
  message: { content: typeof content === "string" ? content : JSON.stringify(content) },
});
const tips = (count = 3) =>
  aiReply({ tips: Array.from({ length: count }, (_, index) => `Tip ${index + 1}`) });

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

beforeEach(() => {
  adviceMock().mockReset().mockResolvedValue(tips());
});

afterEach(async () => {
  await clearAllTables();
});

const THIS_WEEK = weekStartOf(workToday());
const TEXT = { did: "Shipped the page", blocked: "Waiting on copy", nextWeek: "Start checkout" };

async function team() {
  const company = await companyWithTeam();
  const people = await company.build(app);
  const { report, manager } = people;
  const { owner, org } = company;
  const reportPath = (week = THIS_WEEK) => `/v1/my-work/${report.staff.id}/reports/${week}`;
  const submit = (body: Record<string, unknown> = TEXT, week = THIS_WEEK) =>
    request(app).put(reportPath(week)).set(authHeader(report.token)).send(body);
  const advicePath = (id: string) => `/v1/my-work/${report.staff.id}/reports/${id}/advice`;
  const ask = (id: string) => request(app).post(advicePath(id)).set(authHeader(report.token));
  const hrBase = staffPath(org.id, `/${report.staff.id}/performance`);
  const managerBase = `/v1/my-work/${manager.staff.id}/team/${report.staff.id}`;
  return { ...company, ...people, submit, ask, hrBase, managerBase };
}

const waitForCalls = async (mock: jest.Mock, count: number) => {
  for (let attempt = 0; attempt < 200 && mock.mock.calls.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("submitting a report", () => {
  it("saves this week's report and shows it to the employee, manager and HR", async () => {
    const { submit, report, manager, owner, hrBase, managerBase } = await team();
    const res = await submit().expect(200);
    expect(res.body.data.report).toMatchObject({ ...TEXT, weekStart: THIS_WEEK, textVersion: 1 });

    for (const [path, token] of [
      [`/v1/my-work/${report.staff.id}/reports`, report.token],
      [`${managerBase}/reports`, manager.token],
      [`${hrBase}/reports`, owner.token],
    ] as const) {
      const list = await request(app).get(path).set(authHeader(token)).expect(200);
      expect(list.body.data.total).toBe(1);
      expect(list.body.data.items[0].did).toBe(TEXT.did);
    }
  });

  it("creates one report from two submits at once", async () => {
    const { submit, report } = await team();
    const results = await Promise.all([submit(), submit(), submit()]);
    expect(results.map((res) => res.status)).toEqual([200, 200, 200]);
    expect(
      await testDataSource
        .getRepository(StaffWeeklyReport)
        .count({ where: { staffId: report.staff.id } })
    ).toBe(1);
  });

  it("treats an identical retry as nothing, keeping the advice", async () => {
    const { submit, ask } = await team();
    const { body } = await submit().expect(200);
    await ask(body.data.report.id).expect(200);

    const retry = await submit().expect(200);
    expect(retry.body.data.report.textVersion).toBe(1);
    expect(retry.body.data.report.advice).toHaveLength(3);
  });

  it("clears advice when the text changes", async () => {
    const { submit, ask } = await team();
    const { body } = await submit().expect(200);
    await ask(body.data.report.id).expect(200);

    const edited = await submit({ ...TEXT, did: "Shipped more" }).expect(200);
    expect(edited.body.data.report).toMatchObject({ textVersion: 2, advice: null, adviceAt: null });
  });

  it("refuses edits once the manager has added a note, but allows an identical retry", async () => {
    const { submit, manager, managerBase } = await team();
    const { body } = await submit().expect(200);
    await request(app)
      .put(`${managerBase}/reports/${body.data.report.id}/note`)
      .set(authHeader(manager.token))
      .send({ note: "Nice work", textVersion: 1, noteVersion: 0 })
      .expect(200);

    expect((await submit({ ...TEXT, did: "Changed" })).status).toBe(409);
    expect((await submit()).status).toBe(200);
  });

  it("accepts only an open week that starts on a Monday", async () => {
    const { submit } = await team();
    const tuesday = addDays(THIS_WEEK, 1);
    expect((await submit(TEXT, tuesday)).status).toBe(400);
    expect((await submit(TEXT, addDays(THIS_WEEK, 7))).status).toBe(409);
    expect((await submit(TEXT, addDays(THIS_WEEK, -14))).status).toBe(409);
    const lastWeek = addDays(THIS_WEEK, -7);
    expect((await submit(TEXT, lastWeek)).status).toBe(
      isWeekOpen(lastWeek, workToday()) ? 200 : 409
    );
    expect((await submit(TEXT, "not-a-date")).status).toBe(400);
  });

  it("refuses a week before the person's start date, and allows their start week", async () => {
    const { owner, org } = await setupCompany();
    const futureStart = addDays(THIS_WEEK, 14);
    const starter = await employee(app, owner.token, org.id, "New Starter", {
      startDate: futureStart,
    });
    const blocked = await request(app)
      .put(`/v1/my-work/${starter.staff.id}/reports/${THIS_WEEK}`)
      .set(authHeader(starter.token))
      .send(TEXT);
    expect(blocked.status).toBe(409);

    await testDataSource
      .getRepository(StaffMember)
      .update(starter.staff.id, { startDate: addDays(THIS_WEEK, 6) });
    const allowed = await request(app)
      .put(`/v1/my-work/${starter.staff.id}/reports/${THIS_WEEK}`)
      .set(authHeader(starter.token))
      .send(TEXT);
    expect(allowed.status).toBe(200);
  });

  it("validates the text", async () => {
    const { submit } = await team();
    expect((await submit({ ...TEXT, did: "" })).status).toBe(400);
    expect((await submit({ ...TEXT, did: "x".repeat(5001) })).status).toBe(400);
    expect((await submit({ ...TEXT, blocked: "bad\0" })).status).toBe(400);
    expect((await submit({ ...TEXT, nextWeek: 5 })).status).toBe(400);
    expect((await submit({ ...TEXT, did: "x".repeat(5000), blocked: "" })).status).toBe(200);
  });

  it("is only for the record's own person", async () => {
    const { report, colleague, manager, owner } = await team();
    const path = `/v1/my-work/${report.staff.id}/reports/${THIS_WEEK}`;
    for (const token of [colleague.token, manager.token]) {
      expect((await request(app).put(path).set(authHeader(token)).send(TEXT)).status).toBe(404);
    }
    expect((await request(app).put(path).set(authHeader(owner.token)).send(TEXT)).status).toBe(403);
    expect((await request(app).put(path).send(TEXT)).status).toBe(401);
  });

  it("refuses someone whose employment ended", async () => {
    const { submit, owner, org, report } = await team();
    await endStaff(app, owner.token, org.id, report.staff.id, today());
    expect((await submit()).status).toBe(404);
  });
});

describe("manager notes", () => {
  const notePath = (base: string, id: string) => `${base}/reports/${id}/note`;
  const noteBody = (overrides: Record<string, unknown> = {}) => ({
    note: "Nice work",
    textVersion: 1,
    noteVersion: 0,
    ...overrides,
  });

  it("stores who wrote it, and the employee can read it", async () => {
    const { submit, report, manager, managerBase } = await team();
    const { body } = await submit().expect(200);
    const saved = await request(app)
      .put(notePath(managerBase, body.data.report.id))
      .set(authHeader(manager.token))
      .send(noteBody())
      .expect(200);
    expect(saved.body.data.report.managerNoteByName).toContain(manager.user.firstName);

    const mine = await request(app)
      .get(`/v1/my-work/${report.staff.id}/performance`)
      .set(authHeader(report.token))
      .expect(200);
    expect(mine.body.data.performance.reports.items[0].managerNote).toBe("Nice work");
    expect(mine.body.data.performance.currentWeek).toBe(THIS_WEEK);
  });

  it("lets HR stand in", async () => {
    const { submit, owner, hrBase } = await team();
    const { body } = await submit().expect(200);
    const saved = await request(app)
      .put(notePath(hrBase, body.data.report.id))
      .set(authHeader(owner.token))
      .send(noteBody())
      .expect(200);
    expect(saved.body.data.report.managerNoteByName).toContain(owner.user.firstName);
  });

  it("refuses a note on text changed since it was read", async () => {
    const { submit, manager, managerBase } = await team();
    const { body } = await submit().expect(200);
    await submit({ ...TEXT, did: "Rewritten" }).expect(200);
    const res = await request(app)
      .put(notePath(managerBase, body.data.report.id))
      .set(authHeader(manager.token))
      .send(noteBody());
    expect(res.status).toBe(409);
  });

  it("settles a note and an edit arriving together, one way or the other", async () => {
    const { submit, manager, managerBase } = await team();
    const { body } = await submit().expect(200);
    const [note, edit] = await Promise.all([
      request(app)
        .put(notePath(managerBase, body.data.report.id))
        .set(authHeader(manager.token))
        .send(noteBody()),
      submit({ ...TEXT, did: "Edited at the same moment" }),
    ]);
    expect([note.status, edit.status].sort()).toEqual([200, 409]);
  });

  it("lets one of two simultaneous notes win", async () => {
    const { submit, owner, manager, hrBase, managerBase } = await team();
    const { body } = await submit().expect(200);
    const results = await Promise.all([
      request(app)
        .put(notePath(hrBase, body.data.report.id))
        .set(authHeader(owner.token))
        .send(noteBody({ note: "From HR" })),
      request(app)
        .put(notePath(managerBase, body.data.report.id))
        .set(authHeader(manager.token))
        .send(noteBody({ note: "From manager" })),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
  });

  it("refuses bad notes, other people's reports and leaves text out of the activity", async () => {
    const { submit, colleague, manager, report, managerBase } = await team();
    const { body } = await submit().expect(200);
    const id = body.data.report.id;
    const send = (overrides: Record<string, unknown>, token = manager.token) =>
      request(app).put(notePath(managerBase, id)).set(authHeader(token)).send(noteBody(overrides));

    expect((await send({ note: "" })).status).toBe(400);
    expect((await send({ note: "x".repeat(2001) })).status).toBe(400);
    expect((await send({ textVersion: "one" })).status).toBe(400);
    expect((await send({}, colleague.token)).status).toBe(404);
    expect((await send({ note: "Private thoughts" })).status).toBe(200);

    const activity = await testDataSource
      .getRepository(StaffActivity)
      .find({ where: { staffId: report.staff.id } });
    expect(JSON.stringify(activity)).not.toContain("Private thoughts");
  });
});

describe("advice", () => {
  it("saves tips on the report using this week, last week and goals, without names", async () => {
    const { submit, ask, report, org } = await team();
    const repo = testDataSource.getRepository(StaffWeeklyReport);
    const { body } = await submit().expect(200);
    await repo.insert({
      organizationId: org.id,
      staffId: report.staff.id,
      weekStart: addDays(THIS_WEEK, -7),
      did: "Last week's work",
      blocked: "",
      nextWeek: "",
      submittedAt: new Date(),
    });

    const res = await ask(body.data.report.id).expect(200);
    expect(res.body.data.report.advice).toEqual(["Tip 1", "Tip 2", "Tip 3"]);
    const input = adviceMock().mock.calls[0][0];
    expect(input.thisWeek.did).toBe(TEXT.did);
    expect(input.lastWeek.did).toBe("Last week's work");
    expect(JSON.stringify(input)).not.toContain("Ada Obi");
  });

  it("works with no earlier report", async () => {
    const { submit, ask } = await team();
    const { body } = await submit().expect(200);
    await ask(body.data.report.id).expect(200);
    expect(adviceMock().mock.calls[0][0].lastWeek).toBeNull();
  });

  it("is refused on the server for executives", async () => {
    const { submit, ask, report } = await team();
    const { body } = await submit().expect(200);
    await testDataSource.getRepository(StaffMember).update(report.staff.id, { isExecutive: true });
    expect((await ask(body.data.report.id)).status).toBe(403);
    expect(adviceMock()).not.toHaveBeenCalled();
  });

  it("returns saved advice for free", async () => {
    const { submit, ask } = await team();
    const { body } = await submit().expect(200);
    await ask(body.data.report.id).expect(200);
    await ask(body.data.report.id).expect(200);
    expect(adviceMock()).toHaveBeenCalledTimes(1);
  });

  it("makes a second click wait its turn and spends one call", async () => {
    const { submit, ask } = await team();
    const { body } = await submit().expect(200);
    let release: () => void = () => undefined;
    adviceMock().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(tips());
        })
    );
    const first = ask(body.data.report.id).then((res) => res);
    await waitForCalls(adviceMock(), 1);
    expect((await ask(body.data.report.id)).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect((await ask(body.data.report.id)).status).toBe(200);
    expect(adviceMock()).toHaveBeenCalledTimes(1);
  });

  it("saves no advice about text edited during the call", async () => {
    const { submit, ask } = await team();
    const { body } = await submit().expect(200);
    adviceMock().mockImplementation(async () => {
      await submit({ ...TEXT, did: "Edited during the call" }).expect(200);
      return tips();
    });
    expect((await ask(body.data.report.id)).status).toBe(409);
    const row = await testDataSource
      .getRepository(StaffWeeklyReport)
      .findOneOrFail({ where: { id: body.data.report.id } });
    expect(row.advice).toBeNull();
    expect(row.did).toBe("Edited during the call");

    adviceMock().mockResolvedValue(tips());
    expect((await ask(body.data.report.id)).status).toBe(200);
  });

  it("does not lose a manager's note when advice arrives", async () => {
    const { submit, ask, manager, managerBase } = await team();
    const { body } = await submit().expect(200);
    adviceMock().mockImplementation(async () => {
      await request(app)
        .put(`${managerBase}/reports/${body.data.report.id}/note`)
        .set(authHeader(manager.token))
        .send({ note: "Kept", textVersion: 1, noteVersion: 0 })
        .expect(200);
      return tips();
    });
    const res = await ask(body.data.report.id).expect(200);
    const row = await testDataSource
      .getRepository(StaffWeeklyReport)
      .findOneOrFail({ where: { id: body.data.report.id } });
    expect(row.managerNote).toBe("Kept");
    expect(row.advice).toHaveLength(3);
    expect(res.body.data.report.advice).toHaveLength(3);
  });

  it.each([
    ["too few tips", () => tips(2)],
    ["no tips", () => aiReply({ tips: [] })],
    ["unreadable JSON", () => aiReply("{")],
    ["no reply", () => undefined],
  ])("saves nothing and can be retried after %s", async (_name, reply) => {
    const { submit, ask } = await team();
    const { body } = await submit().expect(200);
    adviceMock().mockResolvedValueOnce(reply());
    expect((await ask(body.data.report.id)).status).toBe(502);
    await ask(body.data.report.id).expect(200);
  });

  it("keeps at most five tips and removes NUL bytes", async () => {
    const { submit, ask } = await team();
    const { body } = await submit().expect(200);
    adviceMock().mockResolvedValueOnce(
      aiReply({ tips: Array.from({ length: 9 }, () => "Good\u0000 tip") })
    );
    const res = await ask(body.data.report.id).expect(200);
    expect(res.body.data.report.advice).toHaveLength(5);
    expect(res.body.data.report.advice[0]).toBe("Good tip");
  });

  it("refuses another person's report", async () => {
    const { submit, colleague } = await team();
    const { body } = await submit().expect(200);
    const asColleague = await request(app)
      .post(`/v1/my-work/${colleague.staff.id}/reports/${body.data.report.id}/advice`)
      .set(authHeader(colleague.token));
    expect(asColleague.status).toBe(404);
    expect(adviceMock()).not.toHaveBeenCalled();
  });

  it("is not offered to the manager or HR", async () => {
    const { submit, manager, owner, hrBase, managerBase } = await team();
    const { body } = await submit().expect(200);
    for (const [base, token] of [
      [managerBase, manager.token],
      [hrBase, owner.token],
    ] as const) {
      const res = await request(app)
        .post(`${base}/reports/${body.data.report.id}/advice`)
        .set(authHeader(token));
      expect(res.status).toBe(404);
    }
  });
});

describe("My team", () => {
  it("lists direct reports with this week's status and goals waiting", async () => {
    const { submit, manager, report } = await team();
    const path = `/v1/my-work/${manager.staff.id}/team`;
    let res = await request(app).get(path).set(authHeader(manager.token)).expect(200);
    expect(res.body.data.weekStart).toBe(THIS_WEEK);
    expect(res.body.data.members).toEqual([
      {
        staffId: report.staff.id,
        fullName: "Ada Obi",
        jobTitle: expect.any(String),
        reportId: null,
        goalsWaiting: 0,
      },
    ]);
    const { body } = await submit().expect(200);
    res = await request(app).get(path).set(authHeader(manager.token)).expect(200);
    expect(res.body.data.members[0].reportId).toBe(body.data.report.id);
  });

  it("leaves out people who have left or not started, and shows only direct reports", async () => {
    const { owner, org, boss, manager, report } = await team();
    await employee(app, owner.token, org.id, "Future Hire", {
      managerId: manager.staff.id,
      startDate: addDays(workToday(), 30),
    });
    const left = await employee(app, owner.token, org.id, "Left Already", {
      managerId: manager.staff.id,
    });
    await endStaff(app, owner.token, org.id, left.staff.id, today());

    const mine = await request(app)
      .get(`/v1/my-work/${manager.staff.id}/team`)
      .set(authHeader(manager.token))
      .expect(200);
    expect(mine.body.data.members.map((m: { staffId: string }) => m.staffId)).toEqual([
      report.staff.id,
    ]);
    const bossView = await request(app)
      .get(`/v1/my-work/${boss.staff.id}/team`)
      .set(authHeader(boss.token))
      .expect(200);
    expect(bossView.body.data.members.map((m: { fullName: string }) => m.fullName)).toEqual([
      "Mo Manager",
    ]);
  });

  it("is only for the record's own person and writes one log line", async () => {
    const { manager, report, owner, colleague } = await team();
    const path = `/v1/my-work/${manager.staff.id}/team`;
    expect((await request(app).get(path).set(authHeader(colleague.token))).status).toBe(404);
    expect((await request(app).get(path).set(authHeader(report.token))).status).toBe(404);
    expect((await request(app).get(path).set(authHeader(owner.token))).status).toBe(403);
    await request(app).get(path).set(authHeader(manager.token)).expect(200);
    expect(
      await testDataSource
        .getRepository(StaffAccessLog)
        .count({ where: { actorId: manager.user.id } })
    ).toBe(1);
  });

  it("tells My work who has a team", async () => {
    const { manager, report, colleague } = await team();
    const hasTeam = async (token: string) =>
      (await request(app).get("/v1/my-work").set(authHeader(token)).expect(200)).body.data
        .records[0].hasTeam;
    expect(await hasTeam(manager.token)).toBe(true);
    expect(await hasTeam(report.token)).toBe(false);
    expect(await hasTeam(colleague.token)).toBe(false);
  });

  it("keeps a recruiter member out", async () => {
    const { org, manager } = await team();
    const member = await addMember(org, { canManagePeople: true });
    const res = await request(app)
      .get(`/v1/my-work/${manager.staff.id}/team`)
      .set(authHeader(member.token));
    expect(res.status).toBe(403);
  });
});

describe("weeks with no report", () => {
  it("lists every week since the start, newest first, with missed weeks as not yet", async () => {
    const { owner, org, report, hrBase, submit } = await team();
    await testDataSource
      .getRepository(StaffMember)
      .update({ id: report.staff.id }, { startDate: addDays(THIS_WEEK, -14) });
    await submit().expect(200);

    const res = await request(app).get(hrBase).set(authHeader(owner.token)).expect(200);
    const weeks = res.body.data.performance.weeks as {
      weekStart: string;
      state: string;
      report: { did: string } | null;
    }[];
    expect(weeks.map((week) => [week.weekStart, week.state])).toEqual([
      [THIS_WEEK, "submitted"],
      [addDays(THIS_WEEK, -7), "not_yet"],
      [addDays(THIS_WEEK, -14), "not_yet"],
    ]);
    expect(weeks[0]!.report?.did).toBe(TEXT.did);
    expect(weeks[1]!.report).toBeNull();
    expect(org.id).toBeTruthy();
  });

  it("starts at the week of the start date and never lists earlier weeks", async () => {
    const { owner, hrBase } = await team();
    const res = await request(app).get(hrBase).set(authHeader(owner.token)).expect(200);
    const weeks = res.body.data.performance.weeks as { weekStart: string }[];
    expect(weeks.length).toBeGreaterThanOrEqual(1);
    expect(weeks[weeks.length - 1]!.weekStart <= THIS_WEEK).toBe(true);
    expect(weeks.every((week) => week.weekStart <= THIS_WEEK)).toBe(true);
  });
});
