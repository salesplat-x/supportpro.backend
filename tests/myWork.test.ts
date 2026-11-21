import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { StaffDocument } from "../src/entities/StaffDocument.js";
import { StaffAccessLog, StaffMember } from "../src/entities";
import { StaffAccessResource } from "../src/entities/StaffAccessLog.js";
import { createTalent } from "./helpers/fixtures.js";
import { apiData } from "./helpers/http.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { createStaff, sendDocumentFor, setPay, staffPath, today } from "./helpers/staff.js";

jest.mock("../src/utils/integrations/email/emailService.js", () => {
  const sendDocumentToSign = jest.fn().mockResolvedValue(undefined);
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      sendWelcome: jest.fn().mockResolvedValue(undefined),
      sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
      sendDocumentToSign,
      sendSignedDocument: jest.fn().mockResolvedValue(undefined),
    })),
    sendDocumentToSign,
  };
});

jest.mock("../src/utils/integrations/spaces.js", () => ({
  ...jest.requireActual("../src/utils/integrations/spaces.js"),
  uploadPrivateToSpaces: jest.fn().mockResolvedValue(undefined),
  getFromSpaces: jest.fn().mockResolvedValue(Buffer.from("%PDF-stored")),
  deleteSpacesObjectQuietly: jest.fn().mockResolvedValue(undefined),
}));

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

interface MyWorkRecord {
  staffId: string;
  companyName: string;
  documentsToSign: { id: string; title: string }[];
  signedDocuments: { id: string; title: string; signedAt: string }[];
  tasks: { id: string; title: string; dueOn: string; doneAt: string | null }[];
}

const myWork = async (token: string) =>
  apiData<{ records: MyWorkRecord[] }>(
    await request(app).get("/v1/my-work").set(authHeader(token)).expect(200)
  ).records;

async function companyWithEmployees() {
  const { owner, org } = await setupCompany();
  const employee = async (fullName: string) => {
    const talent = await createTalent();
    const staff = await createStaff(app, owner.token, org.id, {
      fullName,
      startDate: "2026-01-05",
    });
    await testDataSource.getRepository(StaffMember).update(staff.id, { userId: talent.user.id });
    return { ...talent, staff };
  };
  return { owner, org, ada: await employee("Ada Obi"), bayo: await employee("Bayo Lawal") };
}

describe("first-week checklist", () => {
  it("gives each new employee the company's default tasks and lets HR change them", async () => {
    const { owner, org } = await setupCompany();
    const plain = await addMember(org);
    const tasksOf = async (staffId: string) =>
      apiData<{ tasks: { id: string; title: string; dueOn: string }[] }>(
        await request(app)
          .get(staffPath(org.id, `/${staffId}/checklist`))
          .set(authHeader(owner.token))
      ).tasks;

    const first = await createStaff(app, owner.token, org.id, { startDate: "2026-01-05" });
    expect((await tasksOf(first.id)).map((task) => [task.title, task.dueOn])).toEqual([
      ["Set up IT accounts and laptop", "2026-01-05"],
      ["Hand over the welcome pack", "2026-01-05"],
      ["Share the first-week schedule", "2026-01-05"],
    ]);

    await request(app)
      .put(staffPath(org.id, "/checklist-defaults"))
      .set(authHeader(owner.token))
      .send({ items: [{ title: "Meet your team", dueInDays: 2 }] })
      .expect(200);
    const second = await createStaff(app, owner.token, org.id, { startDate: "2026-01-30" });
    expect((await tasksOf(second.id)).map((task) => [task.title, task.dueOn])).toEqual([
      ["Meet your team", "2026-02-01"],
    ]);

    const added = await request(app)
      .post(staffPath(org.id, `/${second.id}/checklist`))
      .set(authHeader(owner.token))
      .send({ title: "Collect your laptop", dueOn: null });
    expect(added.status).toBe(201);
    const { task } = apiData<{ task: { id: string } }>(added);
    await request(app)
      .delete(staffPath(org.id, `/${second.id}/checklist/${task.id}`))
      .set(authHeader(owner.token))
      .expect(200);
    expect(await tasksOf(second.id)).toHaveLength(1);

    expect(
      (
        await request(app)
          .get(staffPath(org.id, `/${second.id}/checklist`))
          .set(authHeader(plain.token))
      ).status
    ).toBe(403);
  });
});

describe("My work", () => {
  it("shows an employee only their own records and refuses another employee's", async () => {
    const { owner, org, ada, bayo } = await companyWithEmployees();
    const logs = () =>
      testDataSource.getRepository(StaffAccessLog).find({ where: { organizationId: org.id } });

    const [record] = await myWork(ada.token);
    expect(record).toMatchObject({ staffId: ada.staff.id, companyName: "Acme Ltd" });
    expect(record?.tasks).toHaveLength(3);
    expect(await logs()).toHaveLength(0);

    const bayoTask = (await myWork(bayo.token))[0]!.tasks[0]!;
    expect(
      (
        await request(app)
          .patch(`/v1/my-work/tasks/${bayoTask.id}`)
          .set(authHeader(ada.token))
          .send({ done: true })
      ).status
    ).toBe(404);
    expect(
      (await request(app).get(`/v1/my-work/${bayo.staff.id}/pay`).set(authHeader(ada.token))).status
    ).toBe(404);

    await setPay(app, owner.token, org.id, ada.staff.id).expect(200);
    const pay = await request(app)
      .get(`/v1/my-work/${ada.staff.id}/pay`)
      .set(authHeader(ada.token));
    expect(pay.status).toBe(200);
    expect(await logs()).toEqual([
      expect.objectContaining({ actorId: ada.user.id, staffId: ada.staff.id, resource: "pay" }),
    ]);
  });

  it("signs a waiting document from My work without breaking the email link first", async () => {
    const { owner, org, ada, bayo } = await companyWithEmployees();
    expect((await sendDocumentFor(app, owner.token, org.id, ada.staff.id)).status).toBe(200);
    const { id } = (await myWork(ada.token))[0]!.documentsToSign[0]!;
    const emailMock = (
      jest.requireMock("../src/utils/integrations/email/emailService.js") as {
        sendDocumentToSign: jest.Mock;
      }
    ).sendDocumentToSign;
    const emailToken = (emailMock.mock.calls[0] as [{ signLink: string }])[0].signLink.split(
      "/sign/"
    )[1]!;

    expect(
      (await request(app).get(`/v1/my-work/documents/${id}`).set(authHeader(bayo.token))).status
    ).toBe(404);
    await request(app).get(`/v1/my-work/documents/${id}`).set(authHeader(ada.token)).expect(200);
    await request(app).get(`/v1/my-work/documents/${id}`).set(authHeader(ada.token)).expect(200);
    await request(app).get(`/v1/staff-documents/${emailToken}`).expect(200);
    const views = await testDataSource
      .getRepository(StaffAccessLog)
      .find({ where: { staffId: ada.staff.id, resource: StaffAccessResource.Contract } });
    expect(views.filter((view) => view.actorId === ada.user.id)).toHaveLength(2);
    expect(views.filter((view) => view.actorId === null)).toHaveLength(1);

    const sign = () =>
      request(app)
        .post(`/v1/my-work/documents/${id}/sign`)
        .set(authHeader(ada.token))
        .send({ fullName: "Ada Obi", agree: true });
    expect((await sign()).status).toBe(200);
    expect((await sign()).status).toBe(404);
    expect((await request(app).get(`/v1/staff-documents/${emailToken}`)).status).toBe(404);
    expect((await myWork(ada.token))[0]!.documentsToSign).toEqual([]);
  });

  it("lets the employee decline a waiting document from My work", async () => {
    const { owner, org, ada, bayo } = await companyWithEmployees();
    expect((await sendDocumentFor(app, owner.token, org.id, ada.staff.id)).status).toBe(200);
    const { id } = (await myWork(ada.token))[0]!.documentsToSign[0]!;
    const decline = (token: string) =>
      request(app).post(`/v1/my-work/documents/${id}/decline`).set(authHeader(token));
    expect((await decline(bayo.token)).status).toBe(404);
    expect((await decline(ada.token)).status).toBe(200);
    expect((await decline(ada.token)).status).toBe(404);
    expect((await myWork(ada.token))[0]!.documentsToSign).toEqual([]);
    const row = await testDataSource.getRepository(StaffDocument).findOneByOrFail({ id });
    expect(row.status).toBe("declined");
  });

  it("lists signed contracts and lets only their owner download them, logging each", async () => {
    const { owner, org, ada, bayo } = await companyWithEmployees();
    expect((await sendDocumentFor(app, owner.token, org.id, ada.staff.id)).status).toBe(200);
    const { id } = (await myWork(ada.token))[0]!.documentsToSign[0]!;
    const pdfPath = `/v1/my-work/documents/${id}/pdf`;
    expect((await request(app).get(pdfPath).set(authHeader(ada.token))).status).toBe(404);

    await request(app)
      .post(`/v1/my-work/documents/${id}/sign`)
      .set(authHeader(ada.token))
      .send({ fullName: "Ada Obi", agree: true })
      .expect(200);

    const [record] = await myWork(ada.token);
    expect(record!.signedDocuments).toEqual([
      { id, title: "Non-disclosure agreement", signedAt: expect.any(String) },
    ]);
    expect(JSON.stringify(record)).not.toContain("confidential information");
    expect((await myWork(bayo.token))[0]!.signedDocuments).toEqual([]);

    expect((await request(app).get(pdfPath).set(authHeader(bayo.token))).status).toBe(404);
    expect((await request(app).get(pdfPath).set(authHeader(owner.token))).status).toBe(403);
    expect((await request(app).get(pdfPath)).status).toBe(401);

    const before = await testDataSource
      .getRepository(StaffAccessLog)
      .count({ where: { staffId: ada.staff.id, actorId: ada.user.id } });
    const download = await request(app).get(pdfPath).set(authHeader(ada.token));
    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toBe("application/pdf");
    expect(
      await testDataSource
        .getRepository(StaffAccessLog)
        .count({ where: { staffId: ada.staff.id, actorId: ada.user.id } })
    ).toBe(before + 1);

    await request(app)
      .post(staffPath(org.id, `/${ada.staff.id}/end`))
      .set(authHeader(owner.token))
      .send({ endDate: today() })
      .expect(200);
    expect((await request(app).get(pdfPath).set(authHeader(ada.token))).status).toBe(404);
  });

  it("hides ended records and refuses recruiter accounts", async () => {
    const { owner, org, ada } = await companyWithEmployees();
    await request(app)
      .post(staffPath(org.id, `/${ada.staff.id}/end`))
      .set(authHeader(owner.token))
      .send({ endDate: today() })
      .expect(200);

    expect(await myWork(ada.token)).toEqual([]);
    expect((await request(app).get("/v1/my-work").set(authHeader(owner.token))).status).toBe(403);
  });
});
