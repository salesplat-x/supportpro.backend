import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { AppDataSource } from "../src/database/dataSource.js";
import {
  StaffAccessLog,
  StaffEfficiencyTip,
  StaffGoal,
  StaffGoalProgressEvent,
  StaffMember,
  StaffMonthlyFeedback,
  StaffWeeklyReport,
} from "../src/entities";
import { StaffAccessResource } from "../src/entities/StaffAccessLog.js";
import { computeEfficiency, reportRateFrom, reportWeeksIn } from "../src/services/efficiency.js";
import { capacityLabel } from "../src/services/quarterlyReview.js";
import {
  addDays,
  quarterFromKey,
  quarterOf,
  weekStartOf,
  workToday,
} from "../src/utils/workCalendar.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { createStaff, staffPath, today } from "./helpers/staff.js";
import { companyWithTeam, endStaff } from "./helpers/team.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  efficiencyTip: jest.fn(),
}));

const tipMock = () =>
  (jest.requireMock("../src/utils/integrations/openai.js") as { efficiencyTip: jest.Mock })
    .efficiencyTip;

const aiReply = (content: unknown) => ({
  message: { content: typeof content === "string" ? content : JSON.stringify(content) },
});

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

beforeEach(() => {
  tipMock()
    .mockReset()
    .mockResolvedValue(aiReply({ tip: "Write your report on Fridays." }));
});

afterEach(async () => {
  await clearAllTables();
});

describe("the efficiency formula", () => {
  const part = (view: ReturnType<typeof computeEfficiency>, key: string) =>
    view.parts.find((item) => item.key === key)!.value;

  it("weights goals 50%, reports 25% and rating 25%", () => {
    const view = computeEfficiency({ goalProgress: 80, reportRate: 100, ratingAverage: 4 });
    expect(view.score).toBe(Math.round(80 * 0.5 + 100 * 0.25 + 80 * 0.25));
    expect(view.partial).toBe(false);
    expect(part(view, "rating")).toBe(80);
  });

  it.each([
    [{ goalProgress: 100, reportRate: 100, ratingAverage: 5 }, 100, false],
    [{ goalProgress: 0, reportRate: 0, ratingAverage: 1 }, 5, false],
    [{ goalProgress: 60, reportRate: null, ratingAverage: null }, 60, true],
    [{ goalProgress: null, reportRate: 40, ratingAverage: null }, 40, true],
    [{ goalProgress: null, reportRate: null, ratingAverage: 3 }, 60, true],
    [{ goalProgress: 100, reportRate: 0, ratingAverage: null }, 67, true],
    [{ goalProgress: 100, reportRate: null, ratingAverage: 1 }, 73, true],
    [{ goalProgress: null, reportRate: 100, ratingAverage: 1 }, 60, true],
  ])("scores %j as %i", (inputs, score, partial) => {
    const view = computeEfficiency(inputs);
    expect(view.score).toBe(score);
    expect(view.partial).toBe(partial);
  });

  it("gives no score, not zero, when there is no data at all", () => {
    expect(
      computeEfficiency({ goalProgress: null, reportRate: null, ratingAverage: null })
    ).toMatchObject({ score: null, partial: true });
  });
});

describe("report weeks", () => {
  const q4 = quarterFromKey("2026-Q4");

  it("starts at the first Monday in the quarter", () => {
    expect(reportWeeksIn("2020-01-01", q4, "2026-11-04").first).toBe("2026-10-05");
    const q1Monday = quarterFromKey("2029-Q1");
    expect(reportWeeksIn("2020-01-01", q1Monday, "2029-02-01").first).toBe("2029-01-01");
  });

  it("starts at a mid-quarter hire's own week", () => {
    expect(reportWeeksIn("2026-11-04", q4, "2026-11-20").first).toBe("2026-11-02");
  });

  it("does not count the current week until it is submitted", () => {
    const today = "2026-10-14";
    expect(reportRateFrom(["2026-10-05"], "2020-01-01", q4, today)).toBe(100);
    expect(reportRateFrom([], "2020-01-01", q4, today)).toBe(0);
    expect(reportRateFrom(["2026-10-05", "2026-10-12"], "2020-01-01", q4, today)).toBe(100);
    expect(reportRateFrom(["2026-10-12"], "2020-01-01", q4, today)).toBe(50);
  });

  it("has no rate before any week could have been finished", () => {
    expect(reportRateFrom([], "2020-01-01", q4, "2026-10-06")).toBeNull();
    expect(reportRateFrom([], "2026-11-16", q4, "2026-11-18")).toBeNull();
    expect(reportRateFrom(["2026-10-05"], "2020-01-01", q4, "2026-10-06")).toBe(100);
  });

  it("ignores a week spanning two quarters in the earlier early days of the new one", () => {
    const q1 = quarterFromKey("2027-Q1");
    expect(reportWeeksIn("2020-01-01", q1, "2027-01-01").first).toBe("2027-01-04");
    expect(reportRateFrom([], "2020-01-01", q1, "2027-01-01")).toBeNull();
  });

  it("counts every week of a finished quarter", () => {
    const weeks = Array.from({ length: 13 }, (_, index) => addDays("2026-10-05", index * 7));
    expect(reportRateFrom(weeks, "2020-01-01", q4, "2027-02-01")).toBe(100);
    expect(reportRateFrom(weeks.slice(0, 6), "2020-01-01", q4, "2027-02-01")).toBeCloseTo(
      (6 / 13) * 100
    );
  });

  it("ignores reports from before the person's start week, so the rate can't pass 100%", () => {
    const rate = reportRateFrom(
      ["2026-11-02", "2026-11-09", "2026-11-16"],
      "2026-11-16",
      q4,
      "2026-11-30"
    );
    expect(rate).toBe(50);
    expect(
      reportRateFrom(
        ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"],
        "2026-11-16",
        q4,
        "2026-11-30"
      )
    ).toBe(100);
  });
});

describe("capacity", () => {
  const base = { daysEmployed: 100, openGoals: 2, onlyNewGoals: false, pace: 30 };

  it.each([
    ["27 days employed", { daysEmployed: 27 }, "not_enough_data"],
    ["28 days employed", { daysEmployed: 28 }, "high"],
    ["no open goals", { openGoals: 0, pace: 0 }, "high"],
    ["only new goals", { onlyNewGoals: true, pace: 0 }, "not_enough_data"],
    ["3 open goals at pace 25", { openGoals: 3, pace: 25 }, "high"],
    ["4 open goals at pace 25", { openGoals: 4, pace: 25 }, "medium"],
    ["3 open goals at pace 24", { openGoals: 3, pace: 24 }, "medium"],
    ["5 open goals at pace 50", { openGoals: 5, pace: 50 }, "medium"],
    ["6 open goals at pace 50", { openGoals: 6, pace: 50 }, "low"],
    ["pace exactly 10", { pace: 10 }, "medium"],
    ["pace just below 10", { pace: 9.9 }, "low"],
  ])("labels %s", (_name, overrides, expected) => {
    expect(capacityLabel({ ...base, ...overrides })).toBe(expected);
  });
});

const QUARTER = quarterOf(workToday());
const THIS_WEEK = weekStartOf(workToday());
const THIS_MONTH = workToday().slice(0, 7);

async function team() {
  const company = await companyWithTeam();
  const people = await company.build(app);
  const { org } = company;
  const { manager, report } = people;
  const addApprovedGoal = async (staffId: string, progress: number, dueOn = "2099-01-01") => {
    const repo = testDataSource.getRepository(StaffGoal);
    return repo.save(
      repo.create({
        organizationId: org.id,
        staffId,
        title: "A goal",
        dueOn,
        progress,
        status: "approved" as never,
        approvedAt: new Date(Date.now() - 60 * 86_400_000),
      })
    );
  };
  const rate = (staffId: string, rating: number, month = THIS_MONTH) =>
    testDataSource.getRepository(StaffMonthlyFeedback).insert({
      organizationId: org.id,
      staffId,
      month: `${month}-01`,
      rating,
      notes: "",
      byName: "Someone",
      updatedAt: new Date(),
    });
  const hrBase = staffPath(org.id, `/${report.staff.id}/performance`);
  const managerBase = `/v1/my-work/${manager.staff.id}/team/${report.staff.id}`;
  return { ...company, ...people, addApprovedGoal, rate, hrBase, managerBase };
}

describe("the efficiency card", () => {
  it("shows HR and the manager the same score, and the employee none", async () => {
    const { owner, manager, report, addApprovedGoal, rate, hrBase, managerBase } = await team();
    await addApprovedGoal(report.staff.id, 80);
    await rate(report.staff.id, 4);

    const hr = await request(app).get(hrBase).set(authHeader(owner.token)).expect(200);
    const asManager = await request(app)
      .get(managerBase)
      .set(authHeader(manager.token))
      .expect(200);
    expect(hr.body.data.performance.efficiency.score).toBe(
      asManager.body.data.performance.efficiency.score
    );
    expect(hr.body.data.performance.efficiency.parts).toHaveLength(3);
    expect(hr.body.data.performance.efficiency.quarter).toBe(QUARTER.key);

    const mine = await request(app)
      .get(`/v1/my-work/${report.staff.id}/performance`)
      .set(authHeader(report.token))
      .expect(200);
    expect(mine.body.data.performance.efficiency).toBeUndefined();
  });

  it("matches the table for the same person", async () => {
    const { owner, org, report, addApprovedGoal, rate, hrBase } = await team();
    await addApprovedGoal(report.staff.id, 55);
    await rate(report.staff.id, 3);
    const card = await request(app).get(hrBase).set(authHeader(owner.token)).expect(200);
    const table = await request(app)
      .get(staffPath(org.id, "/quarterly-review"))
      .set(authHeader(owner.token))
      .expect(200);
    const row = table.body.data.people.find(
      (person: { staffId: string }) => person.staffId === report.staff.id
    );
    expect(row.score).toBe(card.body.data.performance.efficiency.score);
    expect(row.partial).toBe(card.body.data.performance.efficiency.partial);
  });

  it("leaves finished goals from past quarters out of goal progress", async () => {
    const { owner, report, addApprovedGoal, hrBase } = await team();
    await addApprovedGoal(report.staff.id, 100, "2020-01-01");
    await addApprovedGoal(report.staff.id, 20);
    const res = await request(app).get(hrBase).set(authHeader(owner.token)).expect(200);
    const goals = res.body.data.performance.efficiency.parts.find(
      (part: { key: string }) => part.key === "goals"
    );
    expect(goals.value).toBe(20);
  });

  it("counts draft goals and last quarter's ratings for nothing", async () => {
    const { owner, org, report, rate, hrBase } = await team();
    await testDataSource.getRepository(StaffGoal).insert({
      organizationId: org.id,
      staffId: report.staff.id,
      title: "Draft",
      dueOn: "2099-01-01",
    });
    await rate(report.staff.id, 5, addDays(QUARTER.start, -1).slice(0, 7));
    const res = await request(app).get(hrBase).set(authHeader(owner.token)).expect(200);
    const parts = res.body.data.performance.efficiency.parts;
    expect(parts.find((part: { key: string }) => part.key === "goals").value).toBeNull();
    expect(parts.find((part: { key: string }) => part.key === "rating").value).toBeNull();
  });
});

describe("the efficiency tip", () => {
  const ask = (base: string, token: string) =>
    request(app).post(`${base}/efficiency-tip`).set(authHeader(token));

  it("writes one, reuses it while the numbers hold and offers a new one when they move", async () => {
    const { owner, report, addApprovedGoal, hrBase } = await team();
    const goal = await addApprovedGoal(report.staff.id, 50);
    expect((await ask(hrBase, owner.token).expect(200)).body.data.tip).toEqual({
      tip: "Write your report on Fridays.",
      current: true,
    });
    await ask(hrBase, owner.token).expect(200);
    expect(tipMock()).toHaveBeenCalledTimes(1);
    const input = tipMock().mock.calls[0][0];
    expect(JSON.stringify(input)).not.toContain("Ada Obi");
    expect(JSON.stringify(input)).not.toContain("notes");

    await testDataSource.getRepository(StaffGoal).update(goal.id, { progress: 90 });
    const view = await request(app).get(hrBase).set(authHeader(owner.token)).expect(200);
    expect(view.body.data.performance.efficiencyTip.current).toBe(false);
    await ask(hrBase, owner.token).expect(200);
    expect(tipMock()).toHaveBeenCalledTimes(2);
    expect(await testDataSource.getRepository(StaffEfficiencyTip).count()).toBe(1);
  });

  it("is refused on the server for executives", async () => {
    const { owner, report, addApprovedGoal, hrBase } = await team();
    await addApprovedGoal(report.staff.id, 50);
    await testDataSource.getRepository(StaffMember).update(report.staff.id, { isExecutive: true });
    expect((await ask(hrBase, owner.token)).status).toBe(403);
    expect(tipMock()).not.toHaveBeenCalled();
  });

  it("needs a score, and refuses ended staff and outsiders", async () => {
    const { owner, org, colleague, report, addApprovedGoal, hrBase, managerBase } = await team();
    await testDataSource
      .getRepository(StaffMember)
      .update(report.staff.id, { startDate: workToday() });
    expect((await ask(hrBase, owner.token)).status).toBe(409);
    await addApprovedGoal(report.staff.id, 50);
    expect((await ask(managerBase, colleague.token)).status).toBe(404);
    expect((await ask(hrBase, report.token)).status).toBe(403);
    await endStaff(app, owner.token, org.id, report.staff.id, today());
    expect((await ask(hrBase, owner.token)).status).toBe(409);
  });

  it.each([
    ["an empty tip", () => aiReply({ tip: "  " })],
    ["unreadable JSON", () => aiReply("{")],
    ["no reply", () => undefined],
  ])("saves nothing and can be retried after %s", async (_name, reply) => {
    const { owner, report, addApprovedGoal, hrBase } = await team();
    await addApprovedGoal(report.staff.id, 50);
    tipMock().mockResolvedValueOnce(reply());
    expect((await ask(hrBase, owner.token)).status).toBe(502);
    expect(await testDataSource.getRepository(StaffEfficiencyTip).count()).toBe(0);
    await ask(hrBase, owner.token).expect(200);
  });
});

describe("quarterly review", () => {
  const reviewPath = (orgId: string) => staffPath(orgId, "/quarterly-review");
  const review = (token: string, orgId: string, query = "") =>
    request(app)
      .get(`${reviewPath(orgId)}${query}`)
      .set(authHeader(token));
  const saveGoal = (token: string, orgId: string, body: Record<string, unknown> = {}) =>
    request(app)
      .put(`${reviewPath(orgId)}/goal`)
      .set(authHeader(token))
      .send({
        quarter: QUARTER.key,
        currency: "NGN",
        revenueGoal: 1000,
        revenueSoFar: 250,
        version: null,
        ...body,
      });

  it("compares revenue reached with team progress", async () => {
    const { owner, org, report, colleague, addApprovedGoal } = await team();
    await addApprovedGoal(report.staff.id, 40);
    await addApprovedGoal(colleague.staff.id, 60);
    await saveGoal(owner.token, org.id).expect(200);

    const { body } = await review(owner.token, org.id).expect(200);
    expect(body.data).toMatchObject({
      quarter: QUARTER.key,
      revenuePercent: 25,
      teamProgress: 50,
      truncated: false,
    });
    expect(body.data.goal).toMatchObject({ revenueGoal: 1000, revenueSoFar: 250, version: 1 });
    expect(body.data.people.map((person: { fullName: string }) => person.fullName)).toEqual([
      "Ada Obi",
      "Bayo Lawal",
      "Bola Boss",
      "Mo Manager",
    ]);
  });

  it("shows the true number above 100% and copes with no goal or no goals at all", async () => {
    const { owner, org } = await team();
    let { body } = await review(owner.token, org.id).expect(200);
    expect(body.data).toMatchObject({ goal: null, revenuePercent: null, teamProgress: null });

    await saveGoal(owner.token, org.id, { revenueSoFar: 1500 }).expect(200);
    ({ body } = await review(owner.token, org.id).expect(200));
    expect(body.data.revenuePercent).toBe(150);
  });

  it("leaves out ended staff and people who haven't started", async () => {
    const { owner, org, report } = await team();
    await createStaff(app, owner.token, org.id, {
      fullName: "Future Hire",
      startDate: addDays(workToday(), 30),
    });
    await endStaff(app, owner.token, org.id, report.staff.id, today());
    const { body } = await review(owner.token, org.id).expect(200);
    const names = body.data.people.map((person: { fullName: string }) => person.fullName);
    expect(names).not.toContain("Ada Obi");
    expect(names).not.toContain("Future Hire");
  });

  it("works out capacity from the last 28 days of progress", async () => {
    const { owner, org, report, colleague, addApprovedGoal } = await team();
    const events = testDataSource.getRepository(StaffGoalProgressEvent);
    const steady = await addApprovedGoal(report.staff.id, 50);
    await events.insert({ goalId: steady.id, fromProgress: 10, toProgress: 50 });

    const stalled = await addApprovedGoal(colleague.staff.id, 40);
    const old = await events.save(
      events.create({ goalId: stalled.id, fromProgress: 0, toProgress: 40 })
    );
    await testDataSource.query(
      `UPDATE staff_goal_progress_events SET created_at = NOW() - INTERVAL '40 days' WHERE id = $1`,
      [old.id]
    );

    const { body } = await review(owner.token, org.id).expect(200);
    const capacityOf = (name: string) =>
      body.data.people.find((person: { fullName: string }) => person.fullName === name).capacity;
    expect(capacityOf("Ada Obi")).toBe("high");
    expect(capacityOf("Bayo Lawal")).toBe("low");
    expect(capacityOf("Mo Manager")).toBe("high");
  });

  it("does not lower pace because someone finished a goal", async () => {
    const { owner, org, report, addApprovedGoal } = await team();
    const events = testDataSource.getRepository(StaffGoalProgressEvent);
    const finished = await addApprovedGoal(report.staff.id, 100);
    await events.insert({ goalId: finished.id, fromProgress: 0, toProgress: 100 });
    await addApprovedGoal(report.staff.id, 30);
    const { body } = await review(owner.token, org.id).expect(200);
    expect(
      body.data.people.find((person: { fullName: string }) => person.fullName === "Ada Obi")
        .capacity
    ).toBe("high");
  });

  it("does not call someone low because a goal was only just approved", async () => {
    const { owner, org, report, addApprovedGoal } = await team();
    const goal = await addApprovedGoal(report.staff.id, 0);
    await testDataSource.getRepository(StaffGoal).update(goal.id, { approvedAt: new Date() });
    const { body } = await review(owner.token, org.id).expect(200);
    expect(
      body.data.people.find((person: { fullName: string }) => person.fullName === "Ada Obi")
        .capacity
    ).toBe("not_enough_data");
  });

  it("uses the same number of queries however many people there are", async () => {
    const { owner, org } = await team();
    const spy = jest.spyOn(AppDataSource, "query");
    await review(owner.token, org.id).expect(200);
    const small = spy.mock.calls.length;
    spy.mockClear();
    for (let index = 0; index < 8; index += 1) {
      await createStaff(app, owner.token, org.id, { fullName: `Extra ${index}` });
    }
    spy.mockClear();
    await review(owner.token, org.id).expect(200);
    expect(spy.mock.calls.length).toBe(small);
    spy.mockRestore();
  });

  it("marks a list cut off above 1,000 people", async () => {
    const { owner, org } = await setupCompany();
    await testDataSource.query(
      `INSERT INTO staff_members (organization_id, full_name, email, job_title, start_date, status, hired_through_auxhr, is_executive)
       SELECT $1, 'Person ' || n, 'p' || n || '@example.com', 'Role', '2026-01-05', 'active', false, false
       FROM generate_series(1, 1001) AS n`,
      [org.id]
    );
    const { body } = await review(owner.token, org.id).expect(200);
    expect(body.data.truncated).toBe(true);
    expect(body.data.people).toHaveLength(1000);
  });

  it("writes one all-staff log line for each read, and is HR only", async () => {
    const { owner, org, manager } = await team();
    const plain = await addMember(org);
    const other = await setupCompany("Other Ltd");
    await review(owner.token, org.id).expect(200);
    const lines = await testDataSource.getRepository(StaffAccessLog).find({
      where: { organizationId: org.id, resource: StaffAccessResource.Performance },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ staffId: null, staffName: "all staff" });

    for (const token of [plain.token, other.owner.token, manager.token]) {
      expect((await review(token, org.id)).status).toBe(403);
      expect((await saveGoal(token, org.id)).status).toBe(403);
    }
    expect((await request(app).get(reviewPath(org.id))).status).toBe(401);
  });

  it("returns nothing when the read can't be logged", async () => {
    const { owner, org } = await team();
    await testDataSource.query(`ALTER TABLE staff_access_logs RENAME TO staff_access_logs_x`);
    try {
      const res = await review(owner.token, org.id);
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain("Ada Obi");
    } finally {
      await testDataSource.query(`ALTER TABLE staff_access_logs_x RENAME TO staff_access_logs`);
    }
  });

  it("validates the goal", async () => {
    const { owner, org } = await team();
    const save = (body: Record<string, unknown>) => saveGoal(owner.token, org.id, body);
    expect((await save({ revenueGoal: 0 })).status).toBe(400);
    expect((await save({ revenueGoal: -5 })).status).toBe(400);
    expect((await save({ revenueGoal: "1000" })).status).toBe(400);
    expect((await save({ revenueSoFar: -1 })).status).toBe(400);
    expect((await save({ revenueGoal: 1e15 })).status).toBe(400);
    expect((await save({ currency: "XXX" })).status).toBe(400);
    expect((await save({ quarter: "2026-Q5" })).status).toBe(400);
    expect((await save({ quarter: "soon" })).status).toBe(400);
    expect((await save({ revenueSoFar: 0 })).status).toBe(200);
    expect((await review(owner.token, org.id, "?quarter=bad")).status).toBe(400);
    expect((await review(owner.token, org.id, `?quarter=${QUARTER.key}`)).status).toBe(200);
  });

  it("treats a retry as nothing and refuses a stale save", async () => {
    const { owner, org } = await team();
    await saveGoal(owner.token, org.id).expect(200);
    const retry = await saveGoal(owner.token, org.id).expect(200);
    expect(retry.body.data.goal.version).toBe(1);

    expect((await saveGoal(owner.token, org.id, { revenueSoFar: 300 })).status).toBe(409);
    const updated = await saveGoal(owner.token, org.id, { revenueSoFar: 300, version: 1 }).expect(
      200
    );
    expect(updated.body.data.goal).toMatchObject({ revenueSoFar: 300, version: 2 });
    expect((await saveGoal(owner.token, org.id, { revenueSoFar: 400, version: 1 })).status).toBe(
      409
    );
  });

  it("lets one of two different simultaneous saves win", async () => {
    const { owner, org } = await team();
    const first = await Promise.all([
      saveGoal(owner.token, org.id, { revenueSoFar: 1 }),
      saveGoal(owner.token, org.id, { revenueSoFar: 2 }),
    ]);
    expect(first.map((res) => res.status).sort()).toEqual([200, 409]);
    const edits = await Promise.all([
      saveGoal(owner.token, org.id, { revenueSoFar: 10, version: 1 }),
      saveGoal(owner.token, org.id, { revenueSoFar: 20, version: 1 }),
    ]);
    expect(edits.map((res) => res.status).sort()).toEqual([200, 409]);
  });

  it("keeps quarters and companies apart", async () => {
    const { owner, org } = await team();
    const other = await setupCompany("Other Ltd");
    await saveGoal(owner.token, org.id, { quarter: "2026-Q1" }).expect(200);
    await saveGoal(other.owner.token, other.org.id, { quarter: "2026-Q1", revenueGoal: 9 }).expect(
      200
    );
    expect(
      (await review(owner.token, org.id, "?quarter=2026-Q2").expect(200)).body.data.goal
    ).toBeNull();
    expect(
      (await review(owner.token, org.id, "?quarter=2026-Q1").expect(200)).body.data.goal.revenueGoal
    ).toBe(1000);
  });
});

describe("reports counted in the score", () => {
  const reportsPart = async (owner: { token: string }, hrBase: string) => {
    const res = await request(app).get(hrBase).set(authHeader(owner.token)).expect(200);
    return res.body.data.performance.efficiency.parts.find(
      (part: { key: string }) => part.key === "reports"
    ).value;
  };

  it("gives someone with no account no rate, because they can't submit", async () => {
    const { owner, org } = await team();
    const outside = await createStaff(app, owner.token, org.id, { fullName: "Outside Hire" });
    const hrBase = staffPath(org.id, `/${outside.id}/performance`);
    expect(await reportsPart(owner, hrBase)).toBeNull();
    const table = await request(app)
      .get(staffPath(org.id, "/quarterly-review"))
      .set(authHeader(owner.token))
      .expect(200);
    expect(
      table.body.data.people.find(
        (person: { fullName: string }) => person.fullName === "Outside Hire"
      ).score
    ).toBeNull();
  });

  it("counts weeks from the day someone joined, not their earlier start date", async () => {
    const { owner, report, hrBase } = await team();
    expect(await reportsPart(owner, hrBase)).not.toBeNull();
    await testDataSource.getRepository(StaffMember).update(report.staff.id, {
      joinedAt: new Date(),
    });
    expect(await reportsPart(owner, hrBase)).toBeNull();
  });

  it("includes this week once it is submitted", async () => {
    const { owner, org, report, hrBase } = await team();
    await testDataSource
      .getRepository(StaffMember)
      .update(report.staff.id, { startDate: THIS_WEEK });
    await testDataSource.getRepository(StaffWeeklyReport).insert({
      organizationId: org.id,
      staffId: report.staff.id,
      weekStart: THIS_WEEK,
      did: "Work",
      blocked: "",
      nextWeek: "",
      submittedAt: new Date(),
    });
    const res = await request(app).get(hrBase).set(authHeader(owner.token)).expect(200);
    const reports = res.body.data.performance.efficiency.parts.find(
      (part: { key: string }) => part.key === "reports"
    );
    expect(reports.value).toBe(100);
  });
});
