import request from "supertest";
import { createApp } from "../src/app.js";
import { StaffAccessLog, StaffGoal } from "../src/entities";
import { StaffAccessResource } from "../src/entities/StaffAccessLog.js";
import {
  type ReportFrequency,
  addDays,
  monthStartOf,
  periodStartOf,
  weekStartOf,
  workToday,
} from "../src/utils/workCalendar.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { authHeader } from "./helpers/company.js";
import { apiData } from "./helpers/http.js";
import { staffPath } from "./helpers/staff.js";
import { companyWithTeam } from "./helpers/team.js";

jest.mock("../src/utils/integrations/spaces.js", () => ({
  uploadPrivateToSpaces: jest.fn().mockResolvedValue(undefined),
  getFromSpaces: jest.fn(),
  uploadToSpaces: jest.fn(),
  deleteFromSpaces: jest.fn(),
  deleteSpacesObjectQuietly: jest.fn().mockResolvedValue(undefined),
  spacesKeyFor: jest.fn(
    (prefix: string, owner: string, name: string) =>
      `${prefix}/${owner}/${Math.random().toString(36).slice(2)}-${name}`
  ),
  assertSpacesConfigured: jest.fn(),
  ALLOWED_IMAGE_TYPES: [],
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  __esModule: true,
  createEmbedding: jest.fn(),
}));

const spaces = jest.requireMock("../src/utils/integrations/spaces.js") as {
  uploadPrivateToSpaces: jest.Mock;
  getFromSpaces: jest.Mock;
  deleteSpacesObjectQuietly: jest.Mock;
};

const PDF = Buffer.from("%PDF-1.7 proof");

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

beforeEach(() => {
  spaces.getFromSpaces.mockResolvedValue(PDF);
});

afterEach(async () => {
  await clearAllTables();
  jest.clearAllMocks();
});

interface ReportView {
  id: string;
  periodStart: string;
  text: string | null;
  links: string[];
  files: Array<{ id: string; name: string }>;
  textVersion: number;
  noteVersion: number;
  reviewerNote: string | null;
}

interface ReportsView {
  frequency: ReportFrequency | null;
  periods: Array<{ periodStart: string; state: string; open: boolean; report: ReportView | null }>;
  submitted: number;
  missed: number;
}

/** A manager's report with an approved goal whose reporting began `daysAgo` days back. */
async function goalWith(frequency: ReportFrequency | null, daysAgo = 40) {
  const company = await companyWithTeam();
  const { owner, org } = company;
  const { manager, report, colleague } = await company.build(app);
  const managerBase = `/v1/my-work/${manager.staff.id}/team/${report.staff.id}`;
  const goal = apiData<{ goal: { id: string; reportFrequency: ReportFrequency | null } }>(
    await request(app)
      .post(`${managerBase}/goals`)
      .set(authHeader(manager.token))
      .send({
        title: "Close new accounts",
        keyResults: ["Ten a month"],
        dueOn: "2099-01-01",
        reportFrequency: frequency,
      })
      .expect(201)
  ).goal;
  await request(app)
    .post(`${managerBase}/goals/${goal.id}/approve`)
    .set(authHeader(manager.token))
    .send({ version: 1 })
    .expect(200);
  const since = addDays(workToday(), -daysAgo);
  await testDataSource.getRepository(StaffGoal).update(goal.id, {
    approvedAt: new Date(`${since}T09:00:00Z`),
    reportFrequencySince: frequency ? since : null,
  });
  const mine = `/v1/my-work/${report.staff.id}/goals/${goal.id}/reports`;
  const send = (period: string, token = report.token) =>
    request(app).put(`${mine}/${period}`).set(authHeader(token));
  return { owner, org, manager, report, colleague, goal, managerBase, mine, send };
}

describe("goal reports", () => {
  it("saves the goal's report frequency", async () => {
    const { goal } = await goalWith("weekly");

    expect(goal.reportFrequency).toBe("weekly");
    const stored = await testDataSource.getRepository(StaffGoal).findOneByOrFail({ id: goal.id });
    expect(stored.reportFrequency).toBe("weekly");
  });

  it("takes a report with text, a link and a file for the current week", async () => {
    const { send } = await goalWith("weekly");
    const week = weekStartOf(workToday());

    const res = await send(week)
      .field("text", "Called 12 prospects")
      .field("links", "https://example.com/crm")
      .attach("files", PDF, "proof.pdf")
      .expect(200);

    const report = apiData<{ report: ReportView }>(res).report;
    expect(report).toMatchObject({
      periodStart: week,
      text: "Called 12 prospects",
      links: ["https://example.com/crm"],
    });
    expect(report.files.map((file) => file.name)).toEqual(["proof.pdf"]);
    expect(spaces.uploadPrivateToSpaces).toHaveBeenCalledTimes(1);
    expect(spaces.uploadPrivateToSpaces.mock.calls[0][1]).toMatch(/^goal-reports\//);
  });

  it("lists submitted, open and missed periods for the employee and the manager, logging both reads", async () => {
    const { org, report, manager, managerBase, mine, send, goal } = await goalWith("weekly");
    const week = weekStartOf(workToday());
    await send(week).field("text", "Done").expect(200);

    const asEmployee = apiData<ReportsView>(
      await request(app).get(mine).set(authHeader(report.token)).expect(200)
    );
    const asManager = apiData<ReportsView>(
      await request(app)
        .get(`${managerBase}/goals/${goal.id}/reports`)
        .set(authHeader(manager.token))
        .expect(200)
    );

    for (const view of [asEmployee, asManager]) {
      expect(view.frequency).toBe("weekly");
      expect(view.periods[0]).toMatchObject({ periodStart: week, state: "submitted", open: true });
      expect(view.periods.find((period) => period.state === "missed")?.open).toBe(false);
      expect(view.submitted).toBe(1);
      expect(view.missed).toBeGreaterThanOrEqual(4);
    }
    const logs = await testDataSource.getRepository(StaffAccessLog).findBy({
      organizationId: org.id,
      staffId: report.staff.id,
      resource: StaffAccessResource.Performance,
    });
    expect(logs.length).toBeGreaterThanOrEqual(2);
  });

  it("takes a daily report for today's work day and refuses a weekend or future day", async () => {
    const { send } = await goalWith("daily");
    const today = periodStartOf("daily", workToday());
    const saturday = addDays(weekStartOf(workToday()), 5);

    await send(today).field("text", "Visited two shops").expect(200);
    await send(saturday).field("text", "Weekend").expect(400);
    await send(addDays(weekStartOf(workToday()), 7))
      .field("text", "Next week")
      .expect(400);
  });

  it("refuses a period that has closed", async () => {
    const { send } = await goalWith("monthly", 150);
    const twoMonthsBack = monthStartOf(addDays(monthStartOf(monthStartOf(workToday())), -35));

    const res = await send(twoMonthsBack).field("text", "Late").expect(409);

    expect(res.body.error.message).toMatch(/closed/);
  });

  it("needs text, a link or a file, and only https links and real file types", async () => {
    const { send } = await goalWith("weekly");
    const week = weekStartOf(workToday());

    await send(week).field("text", "   ").expect(400);
    await send(week).field("links", "http://example.com").expect(400);
    await send(week).attach("files", Buffer.from("MZ not a pdf"), "fake.pdf").expect(400);

    expect(spaces.uploadPrivateToSpaces).not.toHaveBeenCalled();
  });

  it("replaces a report until the manager replies, then locks it", async () => {
    const { manager, managerBase, goal, send } = await goalWith("weekly");
    const week = weekStartOf(workToday());
    const first = apiData<{ report: ReportView }>(
      await send(week).field("text", "Draft").attach("files", PDF, "one.pdf").expect(200)
    ).report;

    const second = apiData<{ report: ReportView }>(
      await send(week)
        .field("text", "Final")
        .field("keepFileIds", first.files[0]!.id)
        .attach("files", PDF, "two.pdf")
        .expect(200)
    ).report;
    expect(second.id).toBe(first.id);
    expect(second.textVersion).toBe(2);
    expect(second.files.map((file) => file.name)).toEqual(["one.pdf", "two.pdf"]);

    const noteUrl = `${managerBase}/goals/${goal.id}/reports/${second.id}/note`;
    await request(app)
      .put(noteUrl)
      .set(authHeader(manager.token))
      .send({ note: "Good", textVersion: 1, noteVersion: 0 })
      .expect(409);
    await request(app)
      .put(noteUrl)
      .set(authHeader(manager.token))
      .send({ note: "Good", textVersion: 2, noteVersion: 0 })
      .expect(200);

    await send(week).field("text", "Changed").expect(409);
  });

  it("deletes a file the resend drops", async () => {
    const { send } = await goalWith("weekly");
    const week = weekStartOf(workToday());
    await send(week).field("text", "First").attach("files", PDF, "old.pdf").expect(200);
    const oldKey = spaces.uploadPrivateToSpaces.mock.calls[0][1] as string;

    await send(week).field("text", "Second").expect(200);

    expect(spaces.deleteSpacesObjectQuietly).toHaveBeenCalledWith(oldKey, expect.any(String));
  });

  it("refuses draft goals, goals without a frequency, and someone else's goal", async () => {
    const plain = await goalWith(null);
    const week = weekStartOf(workToday());
    await plain.send(week).field("text", "x").expect(409);
    await plain.send(week, plain.colleague.token).field("text", "x").expect(404);

    const { manager, managerBase, report } = plain;
    const draft = apiData<{ goal: { id: string } }>(
      await request(app)
        .post(`${managerBase}/goals`)
        .set(authHeader(manager.token))
        .send({ title: "Draft", keyResults: [], dueOn: "2099-01-01", reportFrequency: "weekly" })
        .expect(201)
    ).goal;
    await request(app)
      .put(`/v1/my-work/${report.staff.id}/goals/${draft.id}/reports/${week}`)
      .set(authHeader(report.token))
      .field("text", "x")
      .expect(404);
  });

  it("lets reviewers download files, but not people outside the team", async () => {
    const { owner, org, manager, colleague, report, managerBase, goal, send } =
      await goalWith("weekly");
    const sent = apiData<{ report: ReportView }>(
      await send(weekStartOf(workToday())).attach("files", PDF, "proof.pdf").expect(200)
    ).report;
    const suffix = `/goals/${goal.id}/reports/${sent.id}/files/${sent.files[0]!.id}`;

    const asManager = await request(app)
      .get(`${managerBase}${suffix}`)
      .set(authHeader(manager.token))
      .expect(200);
    expect(asManager.headers["content-disposition"]).toContain("attachment");
    await request(app)
      .get(staffPath(org.id, `/${report.staff.id}/performance${suffix}`))
      .set(authHeader(owner.token))
      .expect(200);
    await request(app)
      .get(`/v1/my-work/${colleague.staff.id}/team/${report.staff.id}${suffix}`)
      .set(authHeader(colleague.token))
      .expect(404);
  });

  it("removes report files when the goal is removed", async () => {
    const { manager, managerBase, goal, send } = await goalWith("weekly");
    await send(weekStartOf(workToday())).attach("files", PDF, "proof.pdf").expect(200);
    const key = spaces.uploadPrivateToSpaces.mock.calls[0][1] as string;

    await request(app)
      .delete(`${managerBase}/goals/${goal.id}`)
      .set(authHeader(manager.token))
      .expect(200);

    expect(spaces.deleteSpacesObjectQuietly).toHaveBeenCalledWith(key, expect.any(String));
  });
});
