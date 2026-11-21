import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { StaffAccessLog } from "../src/entities";
import { reconcileDueDocumentFinalization } from "../src/services/contracts.js";
import { weekStartOf, workToday } from "../src/utils/workCalendar.js";
import { authHeader } from "./helpers/company.js";
import { sendDocumentFor, staffPath } from "./helpers/staff.js";
import { companyWithTeam } from "./helpers/team.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => {
  const sendDocumentToSign = jest.fn().mockResolvedValue(undefined);
  const sendSignedDocument = jest.fn().mockResolvedValue(undefined);
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      sendWelcome: jest.fn().mockResolvedValue(undefined),
      sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
      sendDocumentToSign,
      sendSignedDocument,
    })),
    sendDocumentToSign,
    sendSignedDocument,
  };
});

jest.mock("../src/utils/integrations/spaces.js", () => {
  const stored = new Map<string, Buffer>();
  return {
    ...jest.requireActual("../src/utils/integrations/spaces.js"),
    uploadPrivateToSpaces: jest.fn(async (file: Buffer, key: string) => {
      stored.set(key, file);
    }),
    getFromSpaces: jest.fn(async (key: string) => stored.get(key)!),
    deleteSpacesObjectQuietly: jest.fn().mockResolvedValue(undefined),
  };
});

const reply = (content: unknown) => ({ message: { content: JSON.stringify(content) } });

jest.mock("../src/utils/integrations/openai.js", () => ({
  generateJobField: jest.fn(),
  suggestGoals: jest.fn(),
  weeklyAdvice: jest.fn(),
  suggestDevelopmentItems: jest.fn(),
  efficiencyTip: jest.fn(),
}));

const ai = () =>
  jest.requireMock("../src/utils/integrations/openai.js") as Record<string, jest.Mock>;

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

describe("the launch journeys", () => {
  it("joining: a contract is sent, read, signed, checked and kept on My work", async () => {
    const company = await companyWithTeam();
    const { report } = await company.build(app);
    const { owner, org } = company;
    const emails = jest.requireMock("../src/utils/integrations/email/emailService.js") as {
      sendDocumentToSign: jest.Mock;
      sendSignedDocument: jest.Mock;
    };

    expect((await sendDocumentFor(app, owner.token, org.id, report.staff.id)).status).toBe(200);
    const [[{ signLink }]] = emails.sendDocumentToSign.mock.calls as [[{ signLink: string }]];
    const token = signLink.split("/sign/")[1]!;

    await request(app).get(`/v1/staff-documents/${token}`).expect(200);
    const signed = await request(app)
      .post(`/v1/staff-documents/${token}/sign`)
      .send({ fullName: "Ada Obi", agree: true })
      .expect(200);
    expect(signed.body.data.signed.copyPending).toBe(false);
    expect(emails.sendSignedDocument).toHaveBeenCalledTimes(2);

    const file = Buffer.from(signed.body.data.signed.pdfBase64, "base64");
    const checked = await request(app)
      .post("/v1/document-checks/file")
      .attach("file", file, { filename: "signed.pdf", contentType: "application/pdf" })
      .expect(200);
    expect(checked.body.data.check.result).toBe("verified");

    const work = await request(app).get("/v1/my-work").set(authHeader(report.token)).expect(200);
    const [record] = work.body.data.records;
    expect(record.documentsToSign).toEqual([]);
    expect(record.signedDocuments).toHaveLength(1);
    const download = await request(app)
      .get(`/v1/my-work/documents/${record.signedDocuments[0].id}/pdf`)
      .set(authHeader(report.token))
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((download.body as Buffer).equals(file)).toBe(true);

    await reconcileDueDocumentFinalization();
    expect(emails.sendSignedDocument).toHaveBeenCalledTimes(2);
  });

  it("performance: from job description to the quarterly review", async () => {
    const company = await companyWithTeam();
    const { manager, report } = await company.build(app);
    const { owner, org } = company;
    const hrBase = staffPath(org.id, `/${report.staff.id}/performance`);
    const teamBase = `/v1/my-work/${manager.staff.id}/team/${report.staff.id}`;
    const mine = `/v1/my-work/${report.staff.id}`;
    const week = weekStartOf(workToday());
    const asManager = (call: request.Test) => call.set(authHeader(manager.token));
    const asEmployee = (call: request.Test) => call.set(authHeader(report.token));

    ai().generateJobField!.mockResolvedValue(reply({ text: "Leads design work." }));
    const draft = await request(app)
      .post(staffPath(org.id, `/${report.staff.id}/job-description/write`))
      .set(authHeader(owner.token))
      .expect(200);
    await request(app)
      .put(staffPath(org.id, `/${report.staff.id}/job-description`))
      .set(authHeader(owner.token))
      .send({ body: draft.body.data.draft.body, version: null })
      .expect(200);

    ai().suggestGoals!.mockResolvedValue(
      reply({
        goals: [1, 2, 3].map((number) => ({
          title: `Goal ${number}`,
          keyResults: ["Result"],
          target: null,
          dueInDays: 60,
        })),
      })
    );
    const suggested = await asManager(request(app).post(`${teamBase}/goals/suggest`)).expect(200);
    const team = await asManager(request(app).get(`/v1/my-work/${manager.staff.id}/team`)).expect(
      200
    );
    expect(team.body.data.members[0].goalsWaiting).toBe(3);

    for (const goal of suggested.body.data.goals) {
      await asManager(request(app).post(`${teamBase}/goals/${goal.id}/approve`))
        .send({ version: goal.version })
        .expect(200);
    }
    const goalId = suggested.body.data.goals[0].id;
    await asEmployee(request(app).patch(`${mine}/goals/${goalId}/progress`))
      .send({ progress: 60 })
      .expect(200);

    const submitted = await asEmployee(request(app).put(`${mine}/reports/${week}`))
      .send({ did: "Shipped", blocked: "", nextWeek: "More" })
      .expect(200);
    const reportId = submitted.body.data.report.id;
    ai().weeklyAdvice!.mockResolvedValue(reply({ tips: ["One", "Two", "Three"] }));
    await asEmployee(request(app).post(`${mine}/reports/${reportId}/advice`)).expect(200);
    await asManager(request(app).put(`${teamBase}/reports/${reportId}/note`))
      .send({ note: "Nice work", textVersion: 1, noteVersion: 0 })
      .expect(200);

    ai().suggestDevelopmentItems!.mockResolvedValue(
      reply({ items: [{ weakArea: "Planning", action: "Plan weekly", dueInDays: 30 }] })
    );
    const proposed = await asManager(request(app).post(`${teamBase}/development/suggest`)).expect(
      200
    );
    const [item] = proposed.body.data.items;
    await asManager(request(app).patch(`${teamBase}/development/${item.id}`))
      .send({
        weakArea: item.weakArea,
        action: item.action,
        dueOn: item.dueOn,
        status: "open",
        version: item.version,
      })
      .expect(200);
    await asEmployee(request(app).patch(`${mine}/development/${item.id}`))
      .send({ done: true })
      .expect(200);

    await asManager(request(app).put(`${teamBase}/feedback/${workToday().slice(0, 7)}`))
      .send({ rating: 4, notes: "Solid", version: null })
      .expect(200);

    ai().efficiencyTip!.mockResolvedValue(reply({ tip: "Keep the weekly habit." }));
    const card = await asManager(request(app).get(teamBase)).expect(200);
    expect(card.body.data.performance.efficiency.score).not.toBeNull();
    await asManager(request(app).post(`${teamBase}/efficiency-tip`)).expect(200);

    const myView = await asEmployee(request(app).get(`${mine}/performance`)).expect(200);
    expect(myView.body.data.performance.goals).toHaveLength(3);
    expect(myView.body.data.performance.feedback[0].notes).toBe("Solid");
    expect(myView.body.data.performance.reports.items[0].managerNote).toBe("Nice work");
    expect(myView.body.data.performance.reports.items[0].advice).toHaveLength(3);

    await request(app)
      .put(staffPath(org.id, "/quarterly-review/goal"))
      .set(authHeader(owner.token))
      .send({
        quarter: card.body.data.performance.efficiency.quarter,
        currency: "NGN",
        revenueGoal: 1000,
        revenueSoFar: 500,
        version: null,
      })
      .expect(200);
    const review = await request(app)
      .get(staffPath(org.id, "/quarterly-review"))
      .set(authHeader(owner.token))
      .expect(200);
    const row = review.body.data.people.find(
      (person: { staffId: string }) => person.staffId === report.staff.id
    );
    expect(review.body.data.revenuePercent).toBe(50);
    expect(row.score).toBe(card.body.data.performance.efficiency.score);
    expect(row.goalProgress).toBe(20);

    const hrView = await request(app).get(hrBase).set(authHeader(owner.token)).expect(200);
    expect(hrView.body.data.performance.reports.total).toBe(1);
    expect(hrView.body.data.performance.efficiencyTip.tip).toBe("Keep the weekly habit.");

    const log = await testDataSource
      .getRepository(StaffAccessLog)
      .find({ where: { staffId: report.staff.id } });
    expect(new Set(log.map((line) => line.actorId))).toEqual(
      new Set([owner.user.id, manager.user.id, report.user.id])
    );
  });
});
