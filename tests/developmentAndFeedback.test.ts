import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { StaffAccessLog, StaffDevelopmentItem, StaffMonthlyFeedback } from "../src/entities";
import { DevelopmentSource, DevelopmentStatus } from "../src/entities/StaffDevelopmentItem.js";
import { StaffAccessResource } from "../src/entities/StaffAccessLog.js";
import { addExternalDevelopmentItem } from "../src/services/development.js";
import { workToday } from "../src/utils/workCalendar.js";
import { authHeader } from "./helpers/company.js";
import { staffPath, today } from "./helpers/staff.js";
import { companyWithTeam, endStaff } from "./helpers/team.js";

jest.mock("../src/utils/integrations/openai.js", () => ({
  suggestDevelopmentItems: jest.fn(),
}));

const aiMock = () =>
  (
    jest.requireMock("../src/utils/integrations/openai.js") as {
      suggestDevelopmentItems: jest.Mock;
    }
  ).suggestDevelopmentItems;

const aiReply = (content: unknown) => ({
  message: { content: typeof content === "string" ? content : JSON.stringify(content) },
});
const itemsReply = (count = 2) =>
  aiReply({
    items: Array.from({ length: count }, (_, index) => ({
      weakArea: `Area ${index + 1}`,
      action: "Pair with a senior",
      dueInDays: 30,
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
  aiMock().mockReset().mockResolvedValue(itemsReply());
});

afterEach(async () => {
  await clearAllTables();
});

const THIS_MONTH = workToday().slice(0, 7);
const LAST_MONTH_START = "2026-01";
const itemBody = (overrides: Record<string, unknown> = {}) => ({
  weakArea: "Public speaking",
  action: "Present at the team meeting",
  dueOn: "2099-01-01",
  ...overrides,
});

async function team() {
  const company = await companyWithTeam();
  const people = await company.build(app);
  const { org } = company;
  const { manager, report } = people;
  const hrBase = staffPath(org.id, `/${report.staff.id}/performance`);
  const managerBase = `/v1/my-work/${manager.staff.id}/team/${report.staff.id}`;
  const mine = `/v1/my-work/${report.staff.id}`;
  const addGoal = () =>
    request(app)
      .post(`${hrBase}/goals`)
      .set(authHeader(company.owner.token))
      .send({ title: "Ship it", keyResults: [], dueOn: "2099-01-01" })
      .expect(201);
  const approveGoal = (id: string) =>
    request(app)
      .post(`${hrBase}/goals/${id}/approve`)
      .set(authHeader(company.owner.token))
      .send({ version: 1 })
      .expect(200);
  const goalReady = async () => approveGoal((await addGoal()).body.data.goal.id);
  return { ...company, ...people, hrBase, managerBase, mine, goalReady };
}

const waitForCalls = async (mock: jest.Mock, count: number) => {
  for (let attempt = 0; attempt < 200 && mock.mock.calls.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("development plan", () => {
  it("adds an item the employee can see and mark done", async () => {
    const { manager, report, managerBase, mine } = await team();
    const { body } = await request(app)
      .post(`${managerBase}/development`)
      .set(authHeader(manager.token))
      .send(itemBody())
      .expect(201);
    const id = body.data.item.id;

    const view = await request(app)
      .get(`${mine}/performance`)
      .set(authHeader(report.token))
      .expect(200);
    expect(view.body.data.performance.development).toHaveLength(1);

    const done = await request(app)
      .patch(`${mine}/development/${id}`)
      .set(authHeader(report.token))
      .send({ done: true })
      .expect(200);
    expect(done.body.data.item.status).toBe("done");
    const undone = await request(app)
      .patch(`${mine}/development/${id}`)
      .set(authHeader(report.token))
      .send({ done: false })
      .expect(200);
    expect(undone.body.data.item.status).toBe("open");
  });

  it("does not make a manager's open form stale when the employee marks it done", async () => {
    const { manager, report, managerBase, mine } = await team();
    const { body } = await request(app)
      .post(`${managerBase}/development`)
      .set(authHeader(manager.token))
      .send(itemBody())
      .expect(201);
    await request(app)
      .patch(`${mine}/development/${body.data.item.id}`)
      .set(authHeader(report.token))
      .send({ done: true })
      .expect(200);
    const edit = await request(app)
      .patch(`${managerBase}/development/${body.data.item.id}`)
      .set(authHeader(manager.token))
      .send({ ...itemBody({ action: "New action" }), status: "open", version: 1 });
    expect(edit.status).toBe(200);
    expect(edit.body.data.item).toMatchObject({ action: "New action", status: "done" });
  });

  it("hides proposals from the employee until the manager accepts one", async () => {
    const { manager, report, managerBase, mine, goalReady } = await team();
    await goalReady();
    const suggested = await request(app)
      .post(`${managerBase}/development/suggest`)
      .set(authHeader(manager.token))
      .expect(200);
    const [first, second] = suggested.body.data.items;
    expect(first.status).toBe("proposed");

    const seen = async () =>
      (await request(app).get(`${mine}/performance`).set(authHeader(report.token)).expect(200)).body
        .data.performance.development;
    expect(await seen()).toEqual([]);
    expect(
      (
        await request(app)
          .patch(`${mine}/development/${first.id}`)
          .set(authHeader(report.token))
          .send({ done: true })
      ).status
    ).toBe(404);

    await request(app)
      .patch(`${managerBase}/development/${first.id}`)
      .set(authHeader(manager.token))
      .send({
        weakArea: first.weakArea,
        action: first.action,
        dueOn: first.dueOn,
        status: "open",
        version: first.version,
      })
      .expect(200);
    await request(app)
      .delete(`${managerBase}/development/${second.id}`)
      .set(authHeader(manager.token))
      .expect(200);
    expect((await seen()).map((item: { id: string }) => item.id)).toEqual([first.id]);
  });

  it("uses goals and reports, with no names or ratings", async () => {
    const { owner, hrBase, goalReady } = await team();
    await goalReady();
    await request(app)
      .post(`${hrBase}/development/suggest`)
      .set(authHeader(owner.token))
      .expect(200);
    const input = aiMock().mock.calls[0][0];
    expect(input.goals[0].title).toBe("Ship it");
    expect(JSON.stringify(input)).not.toContain("Ada Obi");
    expect(JSON.stringify(input)).not.toContain("rating");
  });

  it("asks for goals or reports first instead of guessing", async () => {
    const { owner, hrBase } = await team();
    const res = await request(app)
      .post(`${hrBase}/development/suggest`)
      .set(authHeader(owner.token));
    expect(res.status).toBe(409);
    expect(aiMock()).not.toHaveBeenCalled();
  });

  it("returns existing proposals without another call and lets one of two clicks through", async () => {
    const { owner, hrBase, goalReady } = await team();
    await goalReady();
    let release: () => void = () => undefined;
    aiMock().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(itemsReply());
        })
    );
    const suggest = () =>
      request(app).post(`${hrBase}/development/suggest`).set(authHeader(owner.token));
    const first = suggest().then((res) => res);
    await waitForCalls(aiMock(), 1);
    expect((await suggest()).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect((await suggest()).status).toBe(200);
    expect(aiMock()).toHaveBeenCalledTimes(1);
    expect(await testDataSource.getRepository(StaffDevelopmentItem).count()).toBe(2);
  });

  it.each([
    ["no items", () => aiReply({ items: [] })],
    ["unreadable JSON", () => aiReply("nope")],
    ["no reply", () => undefined],
  ])("saves nothing and can be retried after %s", async (_name, reply) => {
    const { owner, hrBase, goalReady } = await team();
    await goalReady();
    aiMock().mockResolvedValueOnce(reply());
    const suggest = () =>
      request(app).post(`${hrBase}/development/suggest`).set(authHeader(owner.token));
    expect((await suggest()).status).toBe(502);
    expect(await testDataSource.getRepository(StaffDevelopmentItem).count()).toBe(0);
    await suggest().expect(200);
  });

  it("refuses a stale edit, bad input, and goes no further than 50 open items", async () => {
    const { owner, org, report, hrBase } = await team();
    const add = (overrides: Record<string, unknown> = {}) =>
      request(app)
        .post(`${hrBase}/development`)
        .set(authHeader(owner.token))
        .send(itemBody(overrides));

    expect((await add({ weakArea: "" })).status).toBe(400);
    expect((await add({ action: "x".repeat(1001) })).status).toBe(400);
    expect((await add({ dueOn: "soon" })).status).toBe(400);
    expect((await add({ action: "bad\0" })).status).toBe(400);
    expect((await add({ dueOn: null })).status).toBe(201);

    const item = (await add()).body.data.item;
    const edit = (version: number, status = "open") =>
      request(app)
        .patch(`${hrBase}/development/${item.id}`)
        .set(authHeader(owner.token))
        .send({ ...itemBody(), status, version });
    expect((await edit(99)).status).toBe(409);
    expect((await edit(1, "archived")).status).toBe(400);
    const results = await Promise.all([edit(1), edit(1)]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);

    await testDataSource.getRepository(StaffDevelopmentItem).insert(
      Array.from({ length: 48 }, () => ({
        organizationId: org.id,
        staffId: report.staff.id,
        weakArea: "Area",
        action: "Action",
      }))
    );
    expect((await add()).status).toBe(409);
  });

  it("gives another product a safe way in, adding a repeated result once", async () => {
    const { org, report } = await team();
    const input = {
      organizationId: org.id,
      staffId: report.staff.id,
      source: DevelopmentSource.SkillTest,
      sourceRef: "test-result-1",
      weakArea: "SQL",
      action: "Take the SQL course",
    };
    const results = await Promise.all([
      addExternalDevelopmentItem(input),
      addExternalDevelopmentItem(input),
    ]);
    expect(results.map((result) => result.created).sort()).toEqual([false, true]);
    expect(await addExternalDevelopmentItem(input)).toEqual({ created: false });
    expect(await addExternalDevelopmentItem({ ...input, sourceRef: "test-result-2" })).toEqual({
      created: true,
    });
    const rows = await testDataSource.getRepository(StaffDevelopmentItem).find();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toBe(DevelopmentStatus.Open);
  });

  it("refuses people without a right to the plan", async () => {
    const { colleague, boss, report, managerBase, mine, hrBase } = await team();
    for (const token of [colleague.token, boss.token, report.token]) {
      expect(
        (
          await request(app)
            .post(`${managerBase}/development`)
            .set(authHeader(token))
            .send(itemBody())
        ).status
      ).toBe(404);
    }
    expect(
      (
        await request(app)
          .post(`${hrBase}/development`)
          .set(authHeader(report.token))
          .send(itemBody())
      ).status
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch(`${mine}/development/7c9e6679-7425-40de-944b-e07fc1f90ae7`)
          .set(authHeader(colleague.token))
          .send({ done: true })
      ).status
    ).toBe(404);
  });
});

describe("monthly feedback", () => {
  const save = (base: string, token: string, month: string, body: Record<string, unknown>) =>
    request(app)
      .put(`${base}/feedback/${month}`)
      .set(authHeader(token))
      .send({ rating: 4, notes: "Solid month", version: null, ...body });

  it("lets a manager rate and the employee read it, oldest month first", async () => {
    const { manager, report, managerBase, mine } = await team();
    await save(managerBase, manager.token, THIS_MONTH, {}).expect(200);
    await save(managerBase, manager.token, LAST_MONTH_START, { rating: 2 }).expect(200);

    const view = await request(app)
      .get(`${mine}/performance`)
      .set(authHeader(report.token))
      .expect(200);
    const feedback = view.body.data.performance.feedback;
    expect(feedback.map((row: { month: string }) => row.month)).toEqual([
      LAST_MONTH_START,
      THIS_MONTH,
    ]);
    expect(feedback[1]).toMatchObject({ rating: 4, notes: "Solid month" });
    expect(feedback[1].byName).toContain(manager.user.firstName);
  });

  it("logs each read of feedback", async () => {
    const { report, mine } = await team();
    await request(app).get(`${mine}/performance`).set(authHeader(report.token)).expect(200);
    await request(app).get(`${mine}/performance`).set(authHeader(report.token)).expect(200);
    expect(
      await testDataSource.getRepository(StaffAccessLog).count({
        where: { actorId: report.user.id, resource: StaffAccessResource.Performance },
      })
    ).toBe(2);
  });

  it.each([0, 6, 3.5, "4", null])("refuses a rating of %s", async (rating) => {
    const { owner, hrBase } = await team();
    expect((await save(hrBase, owner.token, THIS_MONTH, { rating })).status).toBe(400);
  });

  it.each([1, 5])("accepts a rating of %s", async (rating) => {
    const { owner, hrBase } = await team();
    expect((await save(hrBase, owner.token, THIS_MONTH, { rating })).status).toBe(200);
  });

  it("enforces the rating in the database too", async () => {
    const { owner, hrBase } = await team();
    const { body } = await save(hrBase, owner.token, THIS_MONTH, {}).expect(200);
    await expect(
      testDataSource
        .getRepository(StaffMonthlyFeedback)
        .update(body.data.feedback.id, { rating: 6 })
    ).rejects.toThrow();
  });

  it("refuses future months, months before the start date and bad months", async () => {
    const { owner, hrBase } = await team();
    const send = (month: string) => save(hrBase, owner.token, month, {});
    expect((await send("2099-01")).status).toBe(409);
    expect((await send("2025-12")).status).toBe(409);
    expect((await send("2026-01")).status).toBe(200);
    expect((await send("2026-13")).status).toBe(400);
    expect((await send("2026-1")).status).toBe(400);
  });

  it("treats an identical retry as success and refuses a stale edit", async () => {
    const { owner, hrBase } = await team();
    await save(hrBase, owner.token, THIS_MONTH, {}).expect(200);
    await save(hrBase, owner.token, THIS_MONTH, {}).expect(200);
    expect(await testDataSource.getRepository(StaffMonthlyFeedback).count()).toBe(1);

    expect((await save(hrBase, owner.token, THIS_MONTH, { rating: 1 })).status).toBe(409);
    expect((await save(hrBase, owner.token, THIS_MONTH, { rating: 1, version: 1 })).status).toBe(
      200
    );
    expect((await save(hrBase, owner.token, THIS_MONTH, { rating: 2, version: 1 })).status).toBe(
      409
    );
  });

  it("settles two different first saves with one row and a refusal", async () => {
    const { owner, manager, hrBase, managerBase } = await team();
    const results = await Promise.all([
      save(hrBase, owner.token, THIS_MONTH, { rating: 2 }),
      save(managerBase, manager.token, THIS_MONTH, { rating: 5 }),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(await testDataSource.getRepository(StaffMonthlyFeedback).count()).toBe(1);
  });

  it("keeps out everyone else, and stops once employment ended", async () => {
    const { owner, org, colleague, boss, report, hrBase, managerBase } = await team();
    for (const token of [colleague.token, boss.token, report.token]) {
      expect((await save(managerBase, token, THIS_MONTH, {})).status).toBe(404);
    }
    expect((await save(hrBase, report.token, THIS_MONTH, {})).status).toBe(403);
    expect((await save(hrBase, owner.token, THIS_MONTH, { notes: "bad\0" })).status).toBe(400);
    await endStaff(app, owner.token, org.id, report.staff.id, today());
    expect((await save(hrBase, owner.token, THIS_MONTH, {})).status).toBe(409);
  });
});
