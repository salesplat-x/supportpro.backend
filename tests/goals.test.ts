import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { StaffAccessLog, StaffActivity, StaffGoal, StaffGoalProgressEvent } from "../src/entities";
import { StaffAccessResource } from "../src/entities/StaffAccessLog.js";
import {
  claimAiWork,
  clearOldAiClaims,
  releaseAiWork,
  withAiClaim,
} from "../src/services/peopleAi.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { apiData } from "./helpers/http.js";
import { staffPath, today } from "./helpers/staff.js";
import { companyWithTeam, endStaff } from "./helpers/team.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  generateJobField: jest.fn(),
  suggestGoals: jest.fn(),
}));

const aiMocks = () =>
  jest.requireMock("../src/utils/integrations/openai.js") as {
    generateJobField: jest.Mock;
    suggestGoals: jest.Mock;
  };

const aiReply = (content: unknown) => ({
  message: { content: typeof content === "string" ? content : JSON.stringify(content) },
});

const goalsReply = (count = 3) =>
  aiReply({
    goals: Array.from({ length: count }, (_, index) => ({
      title: `Goal ${index + 1}`,
      keyResults: ["Measure it"],
      target: "10",
      dueInDays: 90,
    })),
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
  aiMocks().suggestGoals.mockReset().mockResolvedValue(goalsReply());
  aiMocks()
    .generateJobField.mockReset()
    .mockResolvedValue(aiReply({ text: "Leads the design work." }));
});

afterEach(async () => {
  await clearAllTables();
});

interface Goal {
  id: string;
  title: string;
  status: string;
  version: number;
  progress: number;
  source: string;
  approvedByName: string | null;
}

const FUTURE = "2099-01-01";
const goalBody = (overrides: Record<string, unknown> = {}) => ({
  title: "Ship the redesign",
  keyResults: ["Launch by March"],
  target: "1 launch",
  dueOn: FUTURE,
  ...overrides,
});

async function team() {
  const company = await companyWithTeam();
  const people = await company.build(app);
  const { owner, org } = company;
  const { manager, report } = people;
  const hrBase = staffPath(org.id, `/${report.staff.id}/performance`);
  const managerBase = `/v1/my-work/${manager.staff.id}/team/${report.staff.id}`;
  const addAsHr = async (overrides: Record<string, unknown> = {}) =>
    apiData<{ goal: Goal }>(
      await request(app)
        .post(`${hrBase}/goals`)
        .set(authHeader(owner.token))
        .send(goalBody(overrides))
        .expect(201)
    ).goal;
  const saveJd = () =>
    request(app)
      .put(staffPath(org.id, `/${report.staff.id}/job-description`))
      .set(authHeader(owner.token))
      .send({ body: "Leads the design work.", version: null })
      .expect(200);
  return { ...company, ...people, hrBase, managerBase, addAsHr, saveJd };
}

describe("job descriptions", () => {
  it("writes a draft without saving it, then saves what HR checked", async () => {
    const { owner, org, report } = await team();
    const write = staffPath(org.id, `/${report.staff.id}/job-description/write`);
    const put = staffPath(org.id, `/${report.staff.id}/job-description`);

    const draft = await request(app).post(write).set(authHeader(owner.token)).expect(200);
    expect(draft.body.data.draft.body).toBe("Leads the design work.");
    const context = aiMocks().generateJobField.mock.calls[0][0];
    expect(context.job.experienceLevel).toContain("Level 3");
    expect(JSON.stringify(context)).not.toContain("Ada Obi");

    const before = await request(app)
      .get(staffPath(org.id, `/${report.staff.id}/performance`))
      .set(authHeader(owner.token));
    expect(before.body.data.performance.jobDescription).toBeNull();

    const saved = await request(app)
      .put(put)
      .set(authHeader(owner.token))
      .send({ body: "Edited by HR", version: null })
      .expect(200);
    expect(saved.body.data.jobDescription).toMatchObject({ body: "Edited by HR", version: 1 });
  });

  it("refuses a stale save and a second first save", async () => {
    const { owner, org, report } = await team();
    const put = staffPath(org.id, `/${report.staff.id}/job-description`);
    const save = (body: string, version: number | null) =>
      request(app).put(put).set(authHeader(owner.token)).send({ body, version });

    const results = await Promise.all([save("One", null), save("Two", null)]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect((await save("Three", 99)).status).toBe(409);
    expect((await save("Four", 1)).status).toBe(200);
  });

  it("refuses over-long text, NUL bytes and an ended person", async () => {
    const { owner, org, report } = await team();
    const put = staffPath(org.id, `/${report.staff.id}/job-description`);
    const save = (body: string) =>
      request(app).put(put).set(authHeader(owner.token)).send({ body, version: null });

    expect((await save("x".repeat(20_001))).status).toBe(400);
    expect((await save("bad\0text")).status).toBe(400);
    expect((await save("")).status).toBe(400);
    await endStaff(app, owner.token, org.id, report.staff.id, today());
    expect((await save("Too late")).status).toBe(409);
  });

  it("gives managers no way to write one", async () => {
    const { manager, report } = await team();
    const res = await request(app)
      .put(`/v1/my-work/${manager.staff.id}/team/${report.staff.id}/job-description`)
      .set(authHeader(manager.token))
      .send({ body: "Mine now", version: null });
    expect(res.status).toBe(404);
  });
});

describe("goals", () => {
  it("lets HR add a draft, the manager approve it and the employee see only approved goals", async () => {
    const { report, manager, managerBase, addAsHr } = await team();
    const goal = await addAsHr();
    expect(goal).toMatchObject({ status: "draft", version: 1 });

    const mine = `/v1/my-work/${report.staff.id}/performance`;
    let view = await request(app).get(mine).set(authHeader(report.token)).expect(200);
    expect(view.body.data.performance.goals).toEqual([]);

    const approved = await request(app)
      .post(`${managerBase}/goals/${goal.id}/approve`)
      .set(authHeader(manager.token))
      .send({ version: 1 })
      .expect(200);
    expect(approved.body.data.goal).toMatchObject({
      status: "approved",
      approvedByName: expect.stringContaining(manager.user.firstName),
    });

    view = await request(app).get(mine).set(authHeader(report.token)).expect(200);
    expect(view.body.data.performance.goals).toHaveLength(1);
  });

  it("lets HR stand in for a manager and records who approved", async () => {
    const { owner, hrBase, addAsHr } = await team();
    const goal = await addAsHr();
    const res = await request(app)
      .post(`${hrBase}/goals/${goal.id}/approve`)
      .set(authHeader(owner.token))
      .send({ version: 1 })
      .expect(200);
    expect(res.body.data.goal.approvedByName).toContain(owner.user.firstName);
  });

  it("treats a double approve as one approval", async () => {
    const { report, manager, managerBase, addAsHr } = await team();
    const goal = await addAsHr();
    const approve = () =>
      request(app)
        .post(`${managerBase}/goals/${goal.id}/approve`)
        .set(authHeader(manager.token))
        .send({ version: 1 });

    const results = await Promise.all([approve(), approve(), approve()]);
    expect(results.map((res) => res.status)).toEqual([200, 200, 200]);
    const approvals = await testDataSource
      .getRepository(StaffActivity)
      .find({ where: { staffId: report.staff.id, type: "goal_approved" as never } });
    expect(approvals).toHaveLength(1);
  });

  it("refuses to approve or edit wording the person did not see", async () => {
    const { owner, manager, hrBase, managerBase, addAsHr } = await team();
    const goal = await addAsHr();
    await request(app)
      .patch(`${hrBase}/goals/${goal.id}`)
      .set(authHeader(owner.token))
      .send({ ...goalBody({ title: "Different goal" }), version: 1 })
      .expect(200);

    expect(
      (
        await request(app)
          .post(`${managerBase}/goals/${goal.id}/approve`)
          .set(authHeader(manager.token))
          .send({ version: 1 })
      ).status
    ).toBe(409);
    expect(
      (
        await request(app)
          .patch(`${managerBase}/goals/${goal.id}`)
          .set(authHeader(manager.token))
          .send({ ...goalBody(), version: 1 })
      ).status
    ).toBe(409);
  });

  it("lets one of two simultaneous edits win", async () => {
    const { owner, hrBase, addAsHr } = await team();
    const goal = await addAsHr();
    const edit = (title: string) =>
      request(app)
        .patch(`${hrBase}/goals/${goal.id}`)
        .set(authHeader(owner.token))
        .send({ ...goalBody({ title }), version: 1 });
    const results = await Promise.all([edit("A"), edit("B")]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
  });

  it("does not make a manager's open form stale when the employee updates progress", async () => {
    const { owner, report, manager, hrBase, managerBase, addAsHr } = await team();
    const goal = await addAsHr();
    await request(app)
      .post(`${hrBase}/goals/${goal.id}/approve`)
      .set(authHeader(owner.token))
      .send({ version: 1 })
      .expect(200);
    await request(app)
      .patch(`/v1/my-work/${report.staff.id}/goals/${goal.id}/progress`)
      .set(authHeader(report.token))
      .send({ progress: 40 })
      .expect(200);

    const edited = await request(app)
      .patch(`${managerBase}/goals/${goal.id}`)
      .set(authHeader(manager.token))
      .send({ ...goalBody({ title: "Reworded" }), version: 1 });
    expect(edited.status).toBe(200);
    expect(edited.body.data.goal.progress).toBe(40);
  });

  it("moves progress within 0 to 99 and records each real change once", async () => {
    const { owner, report, hrBase, addAsHr } = await team();
    const goal = await addAsHr();
    const set = (progress: unknown, token = report.token) =>
      request(app)
        .patch(`/v1/my-work/${report.staff.id}/goals/${goal.id}/progress`)
        .set(authHeader(token))
        .send({ progress });

    expect((await set(50)).status).toBe(404);
    await request(app)
      .post(`${hrBase}/goals/${goal.id}/approve`)
      .set(authHeader(owner.token))
      .send({ version: 1 })
      .expect(200);

    for (const bad of [-1, 100, 101, 50.5, "50", null]) {
      expect((await set(bad)).status).toBe(400);
    }
    expect((await set(0)).status).toBe(200);
    expect((await set(99)).status).toBe(200);
    expect((await set(99)).status).toBe(200);
    expect((await set(40)).status).toBe(200);
    const events = await testDataSource
      .getRepository(StaffGoalProgressEvent)
      .find({ where: { goalId: goal.id } });
    expect(events).toHaveLength(2);
  });

  it("enforces the progress and approval rules in the database too", async () => {
    const { addAsHr } = await team();
    const goal = await addAsHr();
    const repo = testDataSource.getRepository(StaffGoal);
    await expect(repo.update(goal.id, { progress: 101 })).rejects.toThrow();
    await expect(repo.update(goal.id, { status: "approved" as never })).rejects.toThrow();
  });

  it("refuses a past due date, keeps an old one on edit and validates the fields", async () => {
    const { owner, hrBase, addAsHr } = await team();
    const add = (overrides: Record<string, unknown>) =>
      request(app).post(`${hrBase}/goals`).set(authHeader(owner.token)).send(goalBody(overrides));

    expect((await add({ dueOn: "2020-01-01" })).status).toBe(400);
    expect((await add({ dueOn: "not-a-date" })).status).toBe(400);
    expect((await add({ title: "" })).status).toBe(400);
    expect((await add({ title: "x".repeat(201) })).status).toBe(400);
    expect((await add({ title: "bad\0" })).status).toBe(400);
    expect((await add({ keyResults: ["1", "2", "3", "4", "5", "6"] })).status).toBe(400);

    const goal = await addAsHr();
    await testDataSource.getRepository(StaffGoal).update(goal.id, { dueOn: "2020-01-01" });
    const edit = await request(app)
      .patch(`${hrBase}/goals/${goal.id}`)
      .set(authHeader(owner.token))
      .send({ ...goalBody({ title: "Reworded", dueOn: "2020-01-01" }), version: 1 });
    expect(edit.status).toBe(200);
  });

  it("stops at 50 open goals", async () => {
    const { org, report, addAsHr, owner, hrBase } = await team();
    await testDataSource.getRepository(StaffGoal).insert(
      Array.from({ length: 49 }, (_, index) => ({
        organizationId: org.id,
        staffId: report.staff.id,
        title: `Goal ${index}`,
        dueOn: FUTURE,
      }))
    );
    await addAsHr();
    const over = await request(app)
      .post(`${hrBase}/goals`)
      .set(authHeader(owner.token))
      .send(goalBody());
    expect(over.status).toBe(409);
  });

  it("removes a goal and leaves its title on the record", async () => {
    const { owner, report, hrBase, addAsHr } = await team();
    const goal = await addAsHr({ title: "Old idea" });
    await request(app)
      .delete(`${hrBase}/goals/${goal.id}`)
      .set(authHeader(owner.token))
      .expect(200);
    expect(await testDataSource.getRepository(StaffGoal).count()).toBe(0);
    const removed = await testDataSource
      .getRepository(StaffActivity)
      .findOneOrFail({ where: { staffId: report.staff.id, type: "goal_removed" as never } });
    expect(removed.meta).toEqual({ title: "Old idea" });
  });

  it("does not deadlock when a goal write meets a change to the manager", async () => {
    const { owner, org, manager, boss, managerBase, addAsHr } = await team();
    const goal = await addAsHr();
    const runs = Array.from({ length: 6 }, (_, index) =>
      index % 2 === 0
        ? request(app)
            .post(`${managerBase}/goals/${goal.id}/approve`)
            .set(authHeader(manager.token))
            .send({ version: 1 })
        : request(app)
            .patch(staffPath(org.id, `/${manager.staff.id}`))
            .set(authHeader(owner.token))
            .send({ jobTitle: `Lead ${index}`, managerId: boss.staff.id })
    );
    const results = await Promise.all(runs);
    expect(results.every((res) => res.status === 200)).toBe(true);
  });
});

describe("who can reach goals", () => {
  it("refuses everyone without a right to them, on every route", async () => {
    const { org, owner, boss, manager, report, colleague, hrBase, managerBase, addAsHr } =
      await team();
    const goal = await addAsHr();
    const plainMember = await addMember(org);
    const other = await setupCompany("Other Ltd");

    const hrRoutes = (token: string) => [
      request(app).get(hrBase).set(authHeader(token)),
      request(app).post(`${hrBase}/goals`).set(authHeader(token)).send(goalBody()),
      request(app).post(`${hrBase}/goals/suggest`).set(authHeader(token)),
      request(app)
        .post(`${hrBase}/goals/${goal.id}/approve`)
        .set(authHeader(token))
        .send({ version: 1 }),
      request(app).delete(`${hrBase}/goals/${goal.id}`).set(authHeader(token)),
    ];
    for (const token of [plainMember.token, other.owner.token, manager.token, report.token]) {
      const statuses = (await Promise.all(hrRoutes(token))).map((res) => res.status);
      expect(statuses.every((status) => status === 403)).toBe(true);
    }

    const teamRoutes = (token: string, base = managerBase) => [
      request(app).get(base).set(authHeader(token)),
      request(app).post(`${base}/goals`).set(authHeader(token)).send(goalBody()),
      request(app)
        .post(`${base}/goals/${goal.id}/approve`)
        .set(authHeader(token))
        .send({ version: 1 }),
    ];
    for (const token of [colleague.token, boss.token, report.token]) {
      const statuses = (await Promise.all(teamRoutes(token))).map((res) => res.status);
      expect(statuses.every((status) => status === 404)).toBe(true);
    }
    const skipLevel = `/v1/my-work/${boss.staff.id}/team/${report.staff.id}`;
    const skip = (await Promise.all(teamRoutes(boss.token, skipLevel))).map((res) => res.status);
    expect(skip.every((status) => status === 404)).toBe(true);

    const hrTrying = (await Promise.all(teamRoutes(owner.token))).map((res) => res.status);
    expect(hrTrying.every((status) => status === 403)).toBe(true);
    expect((await request(app).get(managerBase)).status).toBe(401);
    expect((await request(app).get(hrBase)).status).toBe(401);
  });

  it("gives a manager no pay, contracts or HR routes", async () => {
    const { org, manager, report, managerBase } = await team();
    for (const suffix of ["/pay", "/documents", "/activity", "/checklist"]) {
      const asHr = await request(app)
        .get(staffPath(org.id, `/${report.staff.id}${suffix}`))
        .set(authHeader(manager.token));
      expect(asHr.status).toBe(403);
      const asTeam = await request(app)
        .get(`${managerBase}${suffix}`)
        .set(authHeader(manager.token));
      expect(asTeam.status).toBe(404);
    }
    expect(
      (await request(app).get(`/v1/my-work/${report.staff.id}/pay`).set(authHeader(manager.token)))
        .status
    ).toBe(404);
  });

  it("drops a manager's access on the next request when the person moves or they leave", async () => {
    const { owner, org, manager, report, colleague, managerBase } = await team();
    const read = () => request(app).get(managerBase).set(authHeader(manager.token));
    expect((await read()).status).toBe(200);

    await request(app)
      .patch(staffPath(org.id, `/${report.staff.id}`))
      .set(authHeader(owner.token))
      .send({ managerId: colleague.staff.id })
      .expect(200);
    expect((await read()).status).toBe(404);

    await request(app)
      .patch(staffPath(org.id, `/${report.staff.id}`))
      .set(authHeader(owner.token))
      .send({ managerId: manager.staff.id })
      .expect(200);
    expect((await read()).status).toBe(200);

    await endStaff(app, owner.token, org.id, manager.staff.id, today());
    expect((await read()).status).toBe(404);
  });

  it("hides an ended report from their manager and makes them read-only for HR", async () => {
    const { owner, org, manager, report, hrBase, managerBase, addAsHr } = await team();
    await addAsHr();
    await endStaff(app, owner.token, org.id, report.staff.id, today());
    expect((await request(app).get(managerBase).set(authHeader(manager.token))).status).toBe(404);
    expect((await request(app).get(hrBase).set(authHeader(owner.token))).status).toBe(200);
    expect(
      (await request(app).post(`${hrBase}/goals`).set(authHeader(owner.token)).send(goalBody()))
        .status
    ).toBe(409);
  });

  it("writes exactly one log line for each read of the tab, by whoever read it", async () => {
    const { owner, manager, report, hrBase, managerBase } = await team();
    await request(app).get(hrBase).set(authHeader(owner.token)).expect(200);
    await request(app).get(managerBase).set(authHeader(manager.token)).expect(200);
    await request(app)
      .get(`/v1/my-work/${report.staff.id}/performance`)
      .set(authHeader(report.token))
      .expect(200);
    const lines = await testDataSource.getRepository(StaffAccessLog).find({
      where: { staffId: report.staff.id, resource: StaffAccessResource.Performance },
    });
    expect(lines.map((line) => line.actorId).sort()).toEqual(
      [owner.user.id, manager.user.id, report.user.id].sort()
    );
  });

  it.each(["hr", "manager", "self"])(
    "returns no data to %s when the log can't be written",
    async (who) => {
      const { owner, manager, report, hrBase, managerBase, addAsHr } = await team();
      await addAsHr({ title: "Secret goal" });
      const paths = {
        hr: [hrBase, owner.token],
        manager: [managerBase, manager.token],
        self: [`/v1/my-work/${report.staff.id}/performance`, report.token],
      } as const;
      const [path, token] = paths[who as keyof typeof paths];
      await testDataSource.query(`ALTER TABLE staff_access_logs RENAME TO staff_access_logs_x`);
      try {
        const res = await request(app).get(path).set(authHeader(token));
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain("Secret goal");
      } finally {
        await testDataSource.query(`ALTER TABLE staff_access_logs_x RENAME TO staff_access_logs`);
      }
    }
  );
});

describe("suggesting goals", () => {
  const suggest = (base: string, token: string) =>
    request(app).post(`${base}/goals/suggest`).set(authHeader(token));

  it("needs a job description, works with an empty company profile and saves drafts", async () => {
    const { owner, hrBase, saveJd } = await team();
    expect((await suggest(hrBase, owner.token)).status).toBe(409);
    expect(aiMocks().suggestGoals).not.toHaveBeenCalled();

    await saveJd();
    const res = await suggest(hrBase, owner.token).expect(200);
    expect(res.body.data.goals).toHaveLength(3);
    expect(res.body.data.goals[0]).toMatchObject({ status: "draft", source: "ai" });
    const input = aiMocks().suggestGoals.mock.calls[0][0];
    expect(input.companyGoals).toEqual([]);
    expect(JSON.stringify(input)).not.toContain("Ada Obi");
  });

  it("returns the drafts already there without calling AI again", async () => {
    const { owner, manager, hrBase, managerBase, saveJd } = await team();
    await saveJd();
    const first = await suggest(hrBase, owner.token).expect(200);
    const second = await suggest(managerBase, manager.token).expect(200);
    expect(aiMocks().suggestGoals).toHaveBeenCalledTimes(1);
    expect(second.body.data.goals.map((goal: Goal) => goal.id)).toEqual(
      first.body.data.goals.map((goal: Goal) => goal.id)
    );
  });

  it("lets one of two simultaneous clicks through and saves one set", async () => {
    const { owner, report, hrBase, saveJd } = await team();
    await saveJd();
    let release: (value: unknown) => void = () => undefined;
    aiMocks().suggestGoals.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(goalsReply());
        })
    );
    const first = suggest(hrBase, owner.token).then((res) => res);
    await waitForCalls(aiMocks().suggestGoals, 1);
    const second = await suggest(hrBase, owner.token);
    expect(second.status).toBe(409);
    release(null);
    expect((await first).status).toBe(200);
    expect(aiMocks().suggestGoals).toHaveBeenCalledTimes(1);
    expect(
      await testDataSource.getRepository(StaffGoal).count({ where: { staffId: report.staff.id } })
    ).toBe(3);
  });

  it("does not suggest over the open goal limit", async () => {
    const { owner, org, report, hrBase, saveJd } = await team();
    await saveJd();
    await testDataSource.getRepository(StaffGoal).insert(
      Array.from({ length: 49 }, (_, index) => ({
        organizationId: org.id,
        staffId: report.staff.id,
        title: `Goal ${index}`,
        dueOn: FUTURE,
        status: "approved" as never,
        approvedAt: new Date(),
      }))
    );
    expect((await suggest(hrBase, owner.token)).status).toBe(409);
  });

  it("passes current goals in so AI doesn't repeat them", async () => {
    const { owner, hrBase, addAsHr, saveJd } = await team();
    await saveJd();
    const goal = await addAsHr({ title: "Existing goal" });
    await request(app)
      .post(`${hrBase}/goals/${goal.id}/approve`)
      .set(authHeader(owner.token))
      .send({ version: 1 })
      .expect(200);
    await suggest(hrBase, owner.token).expect(200);
    expect(aiMocks().suggestGoals.mock.calls[0][0].existingGoals).toEqual(["Existing goal"]);
  });

  it.each([
    ["too few goals", () => goalsReply(2)],
    ["unreadable JSON", () => aiReply("not json")],
    ["no reply", () => undefined],
    ["an empty message", () => ({ message: { content: null } })],
    ["the wrong shape", () => aiReply({ goals: "nope" })],
  ])("saves nothing and can be retried after %s", async (_name, reply) => {
    const { owner, hrBase, saveJd } = await team();
    await saveJd();
    aiMocks().suggestGoals.mockResolvedValueOnce(reply());
    expect((await suggest(hrBase, owner.token)).status).toBe(502);
    expect(await testDataSource.getRepository(StaffGoal).count()).toBe(0);
    await suggest(hrBase, owner.token).expect(200);
  });

  it("releases the claim when the AI call throws", async () => {
    const { owner, hrBase, saveJd } = await team();
    await saveJd();
    aiMocks().suggestGoals.mockRejectedValueOnce(new Error("OpenAI is down"));
    const failed = await suggest(hrBase, owner.token);
    expect(failed.status).toBe(502);
    expect(JSON.stringify(failed.body)).not.toContain("OpenAI is down");
    await suggest(hrBase, owner.token).expect(200);
  });

  it("keeps at most five, strips NUL bytes and clamps due dates", async () => {
    const { owner, hrBase, saveJd } = await team();
    await saveJd();
    aiMocks().suggestGoals.mockResolvedValueOnce(
      aiReply({
        goals: Array.from({ length: 8 }, (_, index) => ({
          title: `Goal\u0000 ${index}`,
          keyResults: Array.from({ length: 9 }, () => "Result"),
          target: null,
          dueInDays: index === 0 ? -5 : 99_999,
        })),
      })
    );
    const res = await suggest(hrBase, owner.token).expect(200);
    expect(res.body.data.goals).toHaveLength(5);
    expect(res.body.data.goals[0].title).toBe("Goal 0");
    expect(res.body.data.goals[0].keyResults).toHaveLength(5);
    expect(res.body.data.goals[0].dueOn >= today()).toBe(true);
    expect(res.body.data.goals[1].dueOn < "2030-01-01").toBe(true);
  });

  it("saves nothing if the person ends during the AI call", async () => {
    const { owner, org, report, hrBase, saveJd } = await team();
    await saveJd();
    aiMocks().suggestGoals.mockImplementation(async () => {
      await endStaff(app, owner.token, org.id, report.staff.id, today());
      return goalsReply();
    });
    expect((await suggest(hrBase, owner.token)).status).toBe(409);
    expect(await testDataSource.getRepository(StaffGoal).count()).toBe(0);
  });

  it("saves nothing for a manager who loses the person during the AI call", async () => {
    const { owner, org, manager, report, colleague, managerBase, saveJd } = await team();
    await saveJd();
    aiMocks().suggestGoals.mockImplementation(async () => {
      await request(app)
        .patch(staffPath(org.id, `/${report.staff.id}`))
        .set(authHeader(owner.token))
        .send({ managerId: colleague.staff.id })
        .expect(200);
      return goalsReply();
    });
    expect((await suggest(managerBase, manager.token)).status).toBe(404);
    expect(await testDataSource.getRepository(StaffGoal).count()).toBe(0);
  });
});

describe("AI claims", () => {
  const claimA = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const claimB = "8d9e6679-7425-40de-944b-e07fc1f90ae8";

  it("refuses a live claim and retakes one left by a crash", async () => {
    expect(await claimAiWork("work", claimA)).toBe(true);
    expect(await claimAiWork("work", claimB)).toBe(false);
    await testDataSource.query(
      `UPDATE people_ai_claims SET claimed_at = NOW() - INTERVAL '4 minutes' WHERE key = 'work'`
    );
    expect(await claimAiWork("work", claimB)).toBe(true);
  });

  it("stops an old holder releasing a newer holder's claim", async () => {
    await claimAiWork("work", claimA);
    await testDataSource.query(
      `UPDATE people_ai_claims SET claimed_at = NOW() - INTERVAL '4 minutes' WHERE key = 'work'`
    );
    await claimAiWork("work", claimB);
    await releaseAiWork("work", claimA);
    expect(await claimAiWork("work", claimA)).toBe(false);
    await releaseAiWork("work", claimB);
    expect(await claimAiWork("work", claimA)).toBe(true);
  });

  it("releases when the work fails, and clears only old leftovers", async () => {
    await expect(withAiClaim("fails", () => Promise.reject(new Error("no")))).rejects.toThrow("no");
    expect(await claimAiWork("fails", claimA)).toBe(true);

    await testDataSource.query(
      `UPDATE people_ai_claims SET claimed_at = NOW() - INTERVAL '2 days' WHERE key = 'fails'`
    );
    await claimAiWork("fresh", claimB);
    await clearOldAiClaims();
    const rows: Array<{ key: string }> = await testDataSource.query(
      `SELECT key FROM people_ai_claims`
    );
    expect(rows.map((row) => row.key)).toEqual(["fresh"]);
  });
});

const waitForCalls = async (mock: jest.Mock, count: number) => {
  for (let attempt = 0; attempt < 200 && mock.mock.calls.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
