import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { CompanyActivity } from "../src/entities/CompanyActivity.js";
import { User } from "../src/entities/User.js";
import { settleActivityWrites } from "../src/services/companyActivity.js";
import { weekStartOf, workToday } from "../src/utils/workCalendar.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import {
  createApplication,
  createJob,
  createOrganization,
  createRecruiter,
  createRole,
  createTalent,
} from "./helpers/fixtures.js";
import { employee } from "./helpers/team.js";
import { setCompanyQuestions } from "./helpers/references.js";
import EmailService from "../src/utils/integrations/email/emailService.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("../src/utils/integrations/openai.js", () => ({
  createEmbedding: jest.fn().mockResolvedValue([{ embedding: new Array(512).fill(0.1) }]),
}));

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await startTestDatabase();
  app = createApp();
}, 120_000);

afterAll(async () => {
  await stopTestDatabase();
});

beforeEach(() => {
  (EmailService as unknown as jest.Mock).mockImplementation(
    () =>
      new Proxy(
        {},
        {
          get: () => jest.fn().mockResolvedValue(undefined),
        }
      )
  );
});

afterEach(async () => {
  await clearAllTables();
  jest.clearAllMocks();
});

const QUESTION = { question: "Did they meet deadlines?", type: "yesno", required: true };

const rows = async () => {
  await settleActivityWrites();
  return testDataSource.getRepository(CompanyActivity).find({ order: { createdAt: "ASC" } });
};

async function setup() {
  const { owner, org } = await setupCompany();
  const member = await addMember(org, { firstName: "Ada", lastName: "Member" });
  const questionsPath = `/v1/organizations/${org.id}/reference-questions`;
  const saveQuestions = (token: string, body: Record<string, unknown> = {}) =>
    request(app)
      .put(questionsPath)
      .set(authHeader(token))
      .send({ questions: [QUESTION], ...body });
  const log = (token: string, query: Record<string, string | number> = {}) =>
    request(app).get(`/v1/organizations/${org.id}/activity`).set(authHeader(token)).query(query);
  return { owner, org, member, saveQuestions, log };
}

describe("writing the company activity log", () => {
  it("records one row for a member's change: who, what, route and field names", async () => {
    const { member, org, saveQuestions } = await setup();
    expect((await saveQuestions(member.token)).status).toBe(200);
    const logged = await rows();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      organizationId: org.id,
      actorId: member.user.id,
      actorName: "Ada Member",
      action: "save reference questions",
      method: "PUT",
      changedFields: ["questions"],
    });
    expect(logged[0]!.route).toContain("/reference-questions");
  });

  it("never stores the values that were sent", async () => {
    const { member, saveQuestions } = await setup();
    await saveQuestions(member.token, { baseSalary: 987654, nin: "12345678901" });
    const logged = await rows();
    expect(logged[0]!.changedFields).toEqual(["questions", "baseSalary", "nin"]);
    const stored = JSON.stringify(logged);
    expect(stored).not.toContain("987654");
    expect(stored).not.toContain("12345678901");
    expect(stored).not.toContain("Did they meet deadlines?");
  });

  it("writes nothing for reads, refused or failed requests, outsiders or logged-out callers", async () => {
    const { member, org, saveQuestions } = await setup();
    await request(app)
      .get(`/v1/organizations/${org.id}/reference-questions`)
      .set(authHeader(member.token));
    expect((await saveQuestions(member.token, { questions: "nope" })).status).toBe(400);
    const { token: stranger } = await createRecruiter();
    expect((await saveQuestions(stranger)).status).toBe(403);
    await request(app).put(`/v1/organizations/${org.id}/reference-questions`).send({});
    expect(await rows()).toHaveLength(0);
  });

  it("leaves out talents applying and personal routes", async () => {
    const { owner, org } = await setup();
    const job = await createJob(owner.user, await createRole(), { organizationId: org.id });
    const talent = await createTalent();
    await request(app).post(`/v1/jobs/applications/${job.id}`).set(authHeader(talent.token));
    const read = await request(app)
      .patch("/v1/notifications/read-all")
      .set(authHeader(owner.token));
    expect(read.status).toBe(200);
    expect(await rows()).toHaveLength(0);
  });

  it("names the item from the route, and keeps the name of something deleted", async () => {
    const { owner, org } = await setup();
    const job = await createJob(owner.user, await createRole("Sales Lead"), {
      organizationId: org.id,
    });
    const talent = await createTalent({ firstName: "Tobi", lastName: "Ade" });
    const application = await createApplication(talent.user, job);
    const referees = await request(app)
      .post(`/v1/references/applications/${application.id}`)
      .set(authHeader(talent.token))
      .send({
        referees: [{ name: "Bola Ref", email: "bola@example.com", relationship: "client" }],
      });
    expect(referees.status).toBe(201);
    await setCompanyQuestions(org.id);
    await request(app)
      .post(`/v1/organizations/${org.id}/reference-questions/send`)
      .set(authHeader(owner.token))
      .send({ jobIds: [job.id] });
    const resend = await request(app)
      .post(`/v1/references/${referees.body.data.references[0].id}/resend`)
      .set(authHeader(owner.token));
    expect(resend.status).toBe(200);

    const doomed = await createJob(owner.user, await createRole("Night Porter"), {
      organizationId: org.id,
    });
    const removed = await request(app).delete(`/v1/jobs/${doomed.id}`).set(authHeader(owner.token));
    expect(removed.status).toBe(200);
    const logged = await rows();
    expect(logged.find((row) => row.action === "resend reference request")).toMatchObject({
      organizationId: org.id,
      targetType: "referee",
      targetLabel: "Bola Ref",
    });
    expect(logged.find((row) => row.action === "delete job")).toMatchObject({
      targetType: "job",
      targetId: doomed.id,
      targetLabel: "Night Porter",
    });
  });

  it("logs a change to another company the person owns under that company", async () => {
    const { owner, org } = await setup();
    const other = await createOrganization(owner.user, { name: "Second Co" });
    await testDataSource
      .getRepository(User)
      .update(owner.user.id, { activeOrganizationId: org.id });
    const added = await request(app)
      .post(`/v1/organizations/${other.id}/departments`)
      .set(authHeader(owner.token))
      .send({ name: "Finance" });
    expect(added.status).toBe(201);
    const logged = await rows();
    expect(logged).toHaveLength(1);
    expect(logged[0]!.organizationId).toBe(other.id);
  });

  it("puts an employee's My Work changes in their employer's log", async () => {
    const { owner, org } = await setup();
    const worker = await employee(app, owner.token, org.id, "Wale Worker");
    await settleActivityWrites();
    await testDataSource.getRepository(CompanyActivity).clear();
    const res = await request(app)
      .put(`/v1/my-work/${worker.staff.id}/reports/${weekStartOf(workToday())}`)
      .set(authHeader(worker.token))
      .send({ did: "Shipped", blocked: "Nothing", nextWeek: "More" });
    expect(res.status).toBeLessThan(400);
    const logged = await rows();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      organizationId: org.id,
      actorId: worker.user.id,
      targetType: "staff",
      targetLabel: "Wale Worker",
    });
  });
});

describe("reading the company activity log", () => {
  it("only the owner can read it, newest first", async () => {
    const { owner, member, saveQuestions, log, org } = await setup();
    const manager = await addMember(org, { canManagePeople: true, firstName: "Pat" });
    await saveQuestions(member.token);
    await saveQuestions(owner.token);
    await settleActivityWrites();

    const res = await log(owner.token);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.items.map((item: { actorName: string }) => item.actorName)).toEqual([
      "Olu Owner",
      "Ada Member",
    ]);
    expect((await log(member.token)).status).toBe(403);
    expect((await log(manager.token)).status).toBe(403);
    const { token: stranger } = await createRecruiter();
    expect((await log(stranger)).status).toBe(403);
  });

  it("filters by person, search and date, and pages", async () => {
    const { owner, member, saveQuestions, log } = await setup();
    await saveQuestions(member.token);
    await saveQuestions(member.token);
    await saveQuestions(owner.token);
    await settleActivityWrites();

    expect((await log(owner.token, { actorId: member.user.id })).body.data.total).toBe(2);
    expect((await log(owner.token, { search: "ada" })).body.data.total).toBe(2);
    expect((await log(owner.token, { search: "nothing like this" })).body.data.total).toBe(0);
    expect((await log(owner.token, { from: "2000-01-01", to: "2000-01-02" })).body.data.total).toBe(
      0
    );
    const page = await log(owner.token, { limit: 1, offset: 1 });
    expect(page.body.data.items).toHaveLength(1);
    expect(page.body.data.total).toBe(3);
    expect((await log(owner.token, { limit: 0 })).status).toBe(400);
    expect((await log(owner.token, { actorId: "nope" })).status).toBe(400);
  });
});
