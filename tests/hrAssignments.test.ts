/**
 * Who can see and do what in People: the creator, a teammate with Can manage people,
 * and a teammate assigned to selected employees.
 */

import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { Notification, OrganizationMember, StaffAccessLog, User } from "../src/entities";
import { StaffAccessResource } from "../src/entities/StaffAccessLog.js";
import { StaffActivity, StaffActivityType } from "../src/entities/StaffActivity.js";
import { StaffHrAssignment } from "../src/entities/StaffHrAssignment.js";
import { StaffGoal, GoalStatus } from "../src/entities/StaffGoal.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { createTalent } from "./helpers/fixtures.js";
import { apiData } from "./helpers/http.js";
import { createStaff, staffPath, type StaffViewShape } from "./helpers/staff.js";
import { linkAccount } from "./helpers/team.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  __esModule: true,
  suggestGoals: jest.fn(),
  suggestDevelopmentItems: jest.fn(),
  efficiencyTip: jest.fn(),
  generateJobField: jest.fn(),
  createEmbedding: jest.fn(),
}));

let app: ReturnType<typeof createApp>;

const FUTURE = "2099-01-01";
const SOME_ID = "9f3b1f7e-1111-4222-8333-444444444444";

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

/** A creator, a switch teammate, an assigned teammate, and two employees. Only `mine` is assigned. */
async function company() {
  const { owner, org } = await setupCompany();
  const manager = await addMember(org, {
    canManagePeople: true,
    firstName: "Sam",
    lastName: "Switch",
  });
  const hr = await addMember(org, { firstName: "Hana", lastName: "Assigned" });
  const mine = await createStaff(app, owner.token, org.id, { fullName: "Ada Mine" });
  const notMine = await createStaff(app, owner.token, org.id, { fullName: "Bayo Other" });
  const res = await assign(owner.token, org.id, { assigneeUserId: hr.user.id, add: [mine.id] });
  expect(res.status).toBe(200);
  return { owner, org, manager, hr, mine, notMine };
}

const assign = (
  token: string,
  orgId: string,
  body: { assigneeUserId: string; add?: string[]; remove?: string[] }
) => request(app).put(staffPath(orgId, "/hr-assignments")).set(authHeader(token)).send(body);

const get = (token: string, path: string) => request(app).get(path).set(authHeader(token));

const addGoal = async (token: string, orgId: string, staffId: string) => {
  const res = await request(app)
    .post(staffPath(orgId, `/${staffId}/performance/goals`))
    .set(authHeader(token))
    .send({ title: "Ship it", keyResults: ["Launch"], target: "1", dueOn: FUTURE });
  expect(res.status).toBe(201);
  return apiData<{ goal: { id: string } }>(res).goal;
};

describe("the access endpoint", () => {
  it("counts only current employees assigned in this company", async () => {
    const { org, hr, mine, owner } = await company();

    const before = await get(hr.token, staffPath(org.id, "/access"));
    expect(apiData<{ access: unknown }>(before).access).toEqual({
      isOwner: false,
      canManagePeople: false,
      assignedCount: 1,
    });

    await request(app)
      .post(staffPath(org.id, `/${mine.id}/end`))
      .set(authHeader(owner.token))
      .send({ endDate: "2026-01-06" })
      .expect(200);

    const after = await get(hr.token, staffPath(org.id, "/access"));
    expect(apiData<{ access: { assignedCount: number } }>(after).access.assignedCount).toBe(0);
  });
});

describe("pay, benefits and contracts are private to the creator", () => {
  const creatorOnly = (orgId: string, staffId: string) => {
    const base = staffPath(orgId, `/${staffId}`);
    return [
      ["get", `${base}/pay`],
      [
        "put",
        `${base}/pay`,
        {
          currency: "NGN",
          period: "monthly",
          baseSalary: 1,
          bonus: 0,
          commissionTarget: 0,
          startsOn: "2026-01-05",
          benefitIds: [],
        },
      ],
      [
        "post",
        staffPath(orgId, "/pay/preview"),
        {
          currency: "NGN",
          period: "monthly",
          baseSalary: 1,
          bonus: 0,
          commissionTarget: 0,
          startsOn: "2026-01-05",
          benefitIds: [],
        },
      ],
      ["delete", `${base}/share-grants/${SOME_ID}`],
      ["get", staffPath(orgId, "/benefits")],
      ["post", staffPath(orgId, "/benefits"), { name: "Health" }],
      ["delete", staffPath(orgId, `/benefits/${SOME_ID}`)],
      ["get", staffPath(orgId, "/commission-plans")],
      ["delete", staffPath(orgId, `/commission-plans/${SOME_ID}`)],
      ["get", staffPath(orgId, "/headcount-cost")],
      ["get", `${base}/documents`],
      ["get", `${base}/documents/preview?template=nda`],
      ["post", `${base}/documents`, { template: "nda" }],
      ["post", `${base}/documents/${SOME_ID}/resend`],
      ["post", `${base}/documents/${SOME_ID}/finalize`],
      ["get", `${base}/documents/${SOME_ID}/pdf`],
      ["get", `${base}/documents/${SOME_ID}/notarized-scan`],
      ["get", staffPath(orgId, "/access-log")],
    ] as Array<["get" | "put" | "post" | "delete", string, object?]>;
  };

  it.each(["hr", "manager"] as const)(
    "refuses the %s on every route, and logs nothing",
    async (who) => {
      const setup = await company();
      const { token } = setup[who];

      for (const [method, path, body] of creatorOnly(setup.org.id, setup.mine.id)) {
        const res = await request(app)[method](path).set(authHeader(token)).send(body);
        expect([path, res.status]).toEqual([path, 403]);
      }

      const logs = await testDataSource.getRepository(StaffAccessLog).find({
        where: [
          { resource: StaffAccessResource.Pay },
          { resource: StaffAccessResource.Contract },
          { resource: StaffAccessResource.HeadcountCost },
        ],
      });
      expect(logs).toHaveLength(0);
    }
  );

  it("still lets the creator in", async () => {
    const { owner, org, mine } = await company();

    expect((await get(owner.token, staffPath(org.id, `/${mine.id}/pay`))).status).toBe(200);
    expect((await get(owner.token, staffPath(org.id, `/${mine.id}/documents`))).status).toBe(200);
    expect((await get(owner.token, staffPath(org.id, "/benefits"))).status).toBe(200);
  });
});

describe("an assigned HR", () => {
  it("sees only the people assigned to them in the list, counts and options", async () => {
    const { org, hr, mine } = await company();

    const list = apiData<{
      items: StaffViewShape[];
      total: number;
      counts: Record<string, number>;
    }>(await get(hr.token, staffPath(org.id)));
    expect(list.items.map((item) => item.id)).toEqual([mine.id]);
    expect(list.total).toBe(1);
    expect(Object.values(list.counts).reduce((sum, count) => sum + count, 0)).toBe(1);

    const options = apiData<{ options: Array<{ id: string }> }>(
      await get(hr.token, staffPath(org.id, "/options?includeEnded=true"))
    );
    expect(options.options.map((option) => option.id)).toEqual([mine.id]);
  });

  it("can read their person's record, activity, performance, reports and tasks", async () => {
    const { org, hr, mine } = await company();
    const base = staffPath(org.id, `/${mine.id}`);

    for (const path of [
      base,
      `${base}/activity`,
      `${base}/performance`,
      `${base}/performance/reports`,
      `${base}/checklist`,
    ]) {
      expect([path, (await get(hr.token, path)).status]).toEqual([path, 200]);
    }
  });

  it("writes a log line for every read of their person", async () => {
    const { org, hr, mine } = await company();

    await get(hr.token, staffPath(org.id, `/${mine.id}/performance`)).expect(200);

    const logs = await testDataSource.getRepository(StaffAccessLog).find({
      where: { actorId: hr.user.id, staffId: mine.id },
    });
    expect(logs.map((log) => log.resource)).toEqual([StaffAccessResource.Performance]);
  });

  it("gets a 404 for anyone else, and nothing is logged", async () => {
    const { org, hr, notMine } = await company();
    const base = staffPath(org.id, `/${notMine.id}`);

    for (const path of [
      base,
      `${base}/activity`,
      `${base}/performance`,
      `${base}/performance/reports`,
      `${base}/checklist`,
    ]) {
      expect([path, (await get(hr.token, path)).status]).toEqual([path, 404]);
    }
    const logs = await testDataSource.getRepository(StaffAccessLog).count({
      where: { actorId: hr.user.id },
    });
    expect(logs).toBe(0);
  });

  it("can't change anything about their person's performance", async () => {
    const { owner, org, hr, mine } = await company();
    const goal = await addGoal(owner.token, org.id, mine.id);
    const perf = staffPath(org.id, `/${mine.id}/performance`);
    const goalBody = { title: "Ship it", keyResults: ["Launch"], target: "1", dueOn: FUTURE };

    const writes: Array<["post" | "patch" | "put" | "delete", string, object?]> = [
      ["post", `${perf}/goals`, goalBody],
      ["post", `${perf}/goals/suggest`],
      ["patch", `${perf}/goals/${goal.id}`, { ...goalBody, version: 1 }],
      ["post", `${perf}/goals/${goal.id}/approve`, { version: 1 }],
      ["delete", `${perf}/goals/${goal.id}`],
      ["put", `${perf}/reports/${SOME_ID}/note`, { note: "Good", textVersion: 1, noteVersion: 0 }],
      ["post", `${perf}/development`, { weakArea: "Speaking", action: "Practise" }],
      ["post", `${perf}/development/suggest`],
      ["delete", `${perf}/development/${SOME_ID}`],
      ["post", `${perf}/efficiency-tip`],
      ["put", `${perf}/feedback/2026-11`, { rating: 5, notes: "", version: null }],
    ];

    for (const [method, path, body] of writes) {
      const res = await request(app)[method](path).set(authHeader(hr.token)).send(body);
      expect([path, res.status]).toEqual([path, 403]);
    }
  });

  it("can't do the company-wide People tasks", async () => {
    const { org, hr, mine } = await company();
    const base = staffPath(org.id, `/${mine.id}`);

    const writes: Array<["get" | "post" | "patch" | "put" | "delete", string, object?]> = [
      ["patch", base, { jobTitle: "Changed" }],
      ["post", `${base}/end`, {}],
      ["post", `${base}/invite`, {}],
      ["post", `${base}/checklist`, { title: "Task" }],
      ["delete", `${base}/checklist/${SOME_ID}`],
      ["post", `${base}/job-description/write`],
      ["put", `${base}/job-description`, { body: "Text", version: null }],
      [
        "post",
        staffPath(org.id),
        { fullName: "New", email: "new@example.com", jobTitle: "X", startDate: "2026-01-05" },
      ],
      ["get", staffPath(org.id, "/export")],
      ["post", staffPath(org.id, "/import"), { rows: [{ fullName: "New" }], commit: false }],
      ["get", staffPath(org.id, "/org-chart")],
      ["get", staffPath(org.id, "/quarterly-review")],
      ["get", staffPath(org.id, "/company-profile")],
      ["get", staffPath(org.id, "/checklist-defaults")],
    ];

    for (const [method, path, body] of writes) {
      const res = await request(app)[method](path).set(authHeader(hr.token)).send(body);
      expect([path, res.status]).toEqual([path, 403]);
    }
  });

  it("loses access when their person's employment ends", async () => {
    const { owner, org, hr, mine } = await company();

    await request(app)
      .post(staffPath(org.id, `/${mine.id}/end`))
      .set(authHeader(owner.token))
      .send({ endDate: "2026-01-06" })
      .expect(200);

    expect((await get(hr.token, staffPath(org.id, `/${mine.id}/performance`))).status).toBe(403);
    expect((await get(hr.token, staffPath(org.id))).status).toBe(403);
  });
});

describe("a teammate with no assignments and no switch", () => {
  it("gets a 403, not a 404, so nothing changes for them", async () => {
    const { org, mine } = await company();
    const plain = await addMember(org, { firstName: "Pat", lastName: "Plain" });

    expect((await get(plain.token, staffPath(org.id))).status).toBe(403);
    expect((await get(plain.token, staffPath(org.id, `/${mine.id}`))).status).toBe(403);
  });
});

describe("a teammate with Can manage people", () => {
  it("keeps the company-wide tasks and sees everyone's performance", async () => {
    const { org, manager, notMine } = await company();

    const list = apiData<{ items: StaffViewShape[] }>(await get(manager.token, staffPath(org.id)));
    expect(list.items).toHaveLength(2);
    for (const path of [
      staffPath(org.id, `/${notMine.id}/performance`),
      staffPath(org.id, "/org-chart"),
      staffPath(org.id, "/quarterly-review"),
      staffPath(org.id, "/export"),
    ]) {
      expect([path, (await get(manager.token, path)).status]).toEqual([path, 200]);
    }
    await addGoal(manager.token, org.id, notMine.id);
  });
});

describe("the activity timeline", () => {
  const seed = (orgId: string, staffId: string, type: StaffActivityType) =>
    testDataSource.getRepository(StaffActivity).save({
      organizationId: orgId,
      staffId,
      actorName: "Someone",
      type,
      meta: { title: "Private" },
    });

  const typesSeenBy = async (token: string, orgId: string, staffId: string) => {
    const res = await get(token, staffPath(orgId, `/${staffId}/activity`));
    expect(res.status).toBe(200);
    return apiData<{ activities: Array<{ type: string }> }>(res).activities.map((row) => row.type);
  };

  it("hides pay and contract events from everyone but the creator", async () => {
    const { owner, org, manager, hr, mine } = await company();
    for (const type of [
      StaffActivityType.PaySet,
      StaffActivityType.ShareGrantAdded,
      StaffActivityType.DocumentSent,
      StaffActivityType.DocumentSigned,
      StaffActivityType.Invited,
      StaffActivityType.GoalAdded,
    ]) {
      await seed(org.id, mine.id, type);
    }

    expect(await typesSeenBy(owner.token, org.id, mine.id)).toEqual(
      expect.arrayContaining([
        "pay_set",
        "share_grant_added",
        "document_sent",
        "invited",
        "goal_added",
      ])
    );

    const forManager = await typesSeenBy(manager.token, org.id, mine.id);
    expect(forManager).toEqual(expect.arrayContaining(["invited", "goal_added"]));
    for (const hidden of ["pay_set", "share_grant_added", "document_sent", "document_signed"]) {
      expect(forManager).not.toContain(hidden);
    }

    const forHr = await typesSeenBy(hr.token, org.id, mine.id);
    expect(forHr).toContain("goal_added");
    expect(forHr).toContain("hr_assigned");
    for (const hidden of ["pay_set", "share_grant_added", "document_sent", "invited"]) {
      expect(forHr).not.toContain(hidden);
    }
  });

  it("applies the filter before the row limit, so private rows can't crowd out the rest", async () => {
    const { org, hr, mine } = await company();
    await seed(org.id, mine.id, StaffActivityType.GoalAdded);
    for (let index = 0; index < 205; index += 1) {
      await seed(org.id, mine.id, StaffActivityType.PaySet);
    }

    expect(await typesSeenBy(hr.token, org.id, mine.id)).toContain("goal_added");
  });

  it("records an employee's goal progress and weekly report", async () => {
    const { owner, org, hr, mine } = await company();
    const goal = await addGoal(owner.token, org.id, mine.id);
    const talent = await createTalent();
    await linkAccount(mine.id, talent.user.id);
    await testDataSource.getRepository(StaffGoal).update(goal.id, {
      status: GoalStatus.Approved,
      approvedAt: new Date(),
      approvedByName: "Olu Owner",
    });

    await request(app)
      .patch(`/v1/my-work/${mine.id}/goals/${goal.id}/progress`)
      .set(authHeader(talent.token))
      .send({ progress: 40 })
      .expect(200);

    expect(await typesSeenBy(hr.token, org.id, mine.id)).toContain("goal_progress_updated");
  });
});

describe("assigning people", () => {
  it("lets only the creator assign", async () => {
    const { org, manager, hr, notMine } = await company();

    const byManager = await assign(manager.token, org.id, {
      assigneeUserId: hr.user.id,
      add: [notMine.id],
    });
    const byHr = await assign(hr.token, org.id, { assigneeUserId: hr.user.id, add: [notMine.id] });
    expect([byManager.status, byHr.status]).toEqual([403, 403]);

    expect((await get(manager.token, staffPath(org.id, `/${notMine.id}/hr`))).status).toBe(403);
    expect(
      (await get(manager.token, staffPath(org.id, `/hr-assignments?assigneeUserId=${hr.user.id}`)))
        .status
    ).toBe(403);
  });

  it("removes access straight away, and shows the change on the timeline", async () => {
    const { owner, org, hr, mine } = await company();

    const res = await assign(owner.token, org.id, {
      assigneeUserId: hr.user.id,
      remove: [mine.id],
    });
    expect(res.status).toBe(200);
    expect(apiData<{ assignedStaffIds: string[] }>(res).assignedStaffIds).toEqual([]);

    expect((await get(hr.token, staffPath(org.id, `/${mine.id}/performance`))).status).toBe(403);
    const activity = await testDataSource
      .getRepository(StaffActivity)
      .find({ where: { staffId: mine.id, type: StaffActivityType.HrRemoved } });
    expect(activity).toHaveLength(1);
  });

  it("lists who is assigned to an employee, and allows more than one", async () => {
    const { owner, org, hr, manager, mine } = await company();

    await assign(owner.token, org.id, { assigneeUserId: manager.user.id, add: [mine.id] }).expect(
      200
    );

    const { assignees } = apiData<{ assignees: Array<{ userId: string }> }>(
      await get(owner.token, staffPath(org.id, `/${mine.id}/hr`))
    );
    expect(assignees.map((assignee) => assignee.userId).sort()).toEqual(
      [hr.user.id, manager.user.id].sort()
    );
  });

  it("lets the creator assign themselves, and find those people with a filter", async () => {
    const { owner, org, mine, notMine } = await company();

    await assign(owner.token, org.id, { assigneeUserId: owner.user.id, add: [notMine.id] }).expect(
      200
    );

    const filtered = apiData<{ items: StaffViewShape[]; total: number }>(
      await get(owner.token, staffPath(org.id, "?assignedToMe=true"))
    );
    expect(filtered.items.map((item) => item.id)).toEqual([notMine.id]);
    expect(filtered.total).toBe(1);

    const everyone = apiData<{ total: number }>(await get(owner.token, staffPath(org.id)));
    expect(everyone.total).toBe(2);
    expect((await get(owner.token, staffPath(org.id, `/${mine.id}/pay`))).status).toBe(200);
  });

  it("doesn't change anything for a repeat, and tells the teammate once", async () => {
    const { owner, org, hr, mine } = await company();

    await assign(owner.token, org.id, { assigneeUserId: hr.user.id, add: [mine.id] }).expect(200);

    expect(await testDataSource.getRepository(StaffHrAssignment).count()).toBe(1);
    const notices = await testDataSource
      .getRepository(Notification)
      .find({ where: { userId: hr.user.id, type: "hr_assigned" } });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.message).toContain("Ada Mine");
    expect(notices[0]?.organizationId).toBe(org.id);
    expect(notices[0]?.link).toBe("/recruiterDashboard/people/employees");
  });

  it("refuses another company's staff, and changes nothing in that batch", async () => {
    const { owner, org, hr, notMine } = await company();
    const other = await setupCompany("Other Ltd");
    const foreign = await createStaff(app, other.owner.token, other.org.id);

    const res = await assign(owner.token, org.id, {
      assigneeUserId: hr.user.id,
      add: [notMine.id, foreign.id],
    });

    expect(res.status).toBe(404);
    expect(
      await testDataSource
        .getRepository(StaffHrAssignment)
        .count({ where: { staffId: notMine.id } })
    ).toBe(0);
    expect((await get(owner.token, staffPath(org.id, `/${foreign.id}/hr`))).status).toBe(404);
  });

  it("refuses someone who isn't on the company team", async () => {
    const { owner, org, mine } = await company();
    const talent = await createTalent();
    const other = await setupCompany("Other Ltd");

    expect(
      (await assign(owner.token, org.id, { assigneeUserId: talent.user.id, add: [mine.id] })).status
    ).toBe(404);
    expect(
      (await assign(owner.token, org.id, { assigneeUserId: other.owner.user.id, add: [mine.id] }))
        .status
    ).toBe(404);
  });

  it("refuses to assign someone to their own record, by account or work email", async () => {
    const { owner, org, hr } = await company();
    const byAccount = await createStaff(app, owner.token, org.id, {
      fullName: "Hana Assigned",
      email: hr.user.email,
    });
    await testDataSource
      .getRepository(OrganizationMember)
      .update({ userId: hr.user.id }, { workEmail: "hana@acme.example.com" });
    const byWorkEmail = await createStaff(app, owner.token, org.id, {
      fullName: "Hana At Work",
      email: "hana@acme.example.com",
    });

    expect(
      (await assign(owner.token, org.id, { assigneeUserId: hr.user.id, add: [byAccount.id] }))
        .status
    ).toBe(409);
    expect(
      (await assign(owner.token, org.id, { assigneeUserId: hr.user.id, add: [byWorkEmail.id] }))
        .status
    ).toBe(409);
  });

  it("refuses an ended employee, but allows removing one", async () => {
    const { owner, org, hr, mine, notMine } = await company();
    for (const id of [mine.id, notMine.id]) {
      await request(app)
        .post(staffPath(org.id, `/${id}/end`))
        .set(authHeader(owner.token))
        .send({ endDate: "2026-01-06" })
        .expect(200);
    }

    expect(
      (await assign(owner.token, org.id, { assigneeUserId: hr.user.id, add: [notMine.id] })).status
    ).toBe(409);
    expect(
      (await assign(owner.token, org.id, { assigneeUserId: hr.user.id, remove: [mine.id] })).status
    ).toBe(200);
  });

  it("rejects bad input", async () => {
    const { owner, org, hr, mine } = await company();

    const sameBoth = await assign(owner.token, org.id, {
      assigneeUserId: hr.user.id,
      add: [mine.id],
      remove: [mine.id],
    });
    const notUuid = await assign(owner.token, org.id, {
      assigneeUserId: hr.user.id,
      add: ["nope"],
    });
    const noAssignee = await assign(owner.token, org.id, {
      assigneeUserId: "nope",
      add: [mine.id],
    });
    const tooMany = await assign(owner.token, org.id, {
      assigneeUserId: hr.user.id,
      add: Array.from({ length: 201 }, () => mine.id),
    });

    expect([sameBoth.status, notUuid.status, noAssignee.status, tooMany.status]).toEqual([
      400, 400, 400, 400,
    ]);
  });

  it("disappears when the teammate's account is deleted", async () => {
    const { hr } = await company();

    await testDataSource.query(`UPDATE staff_hr_assignments SET assigned_by_id = NULL`);
    await testDataSource.query(`DELETE FROM notifications WHERE user_id = $1`, [hr.user.id]);
    await testDataSource.query(`DELETE FROM organization_members WHERE user_id = $1`, [hr.user.id]);
    await testDataSource.query(`UPDATE users SET active_organization_id = NULL WHERE id = $1`, [
      hr.user.id,
    ]);
    await testDataSource.getRepository(User).delete(hr.user.id);

    expect(await testDataSource.getRepository(StaffHrAssignment).count()).toBe(0);
  });
});
