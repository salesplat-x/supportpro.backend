import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { StaffAccessLog, StaffActivity, StaffDocument } from "../src/entities";
import { apiData } from "./helpers/http.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { createStaff, setPay, staffPath, today } from "./helpers/staff.js";

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

jest.mock("../src/utils/integrations/spaces.js", () => ({
  ...jest.requireActual("../src/utils/integrations/spaces.js"),
  uploadPrivateToSpaces: jest.fn().mockResolvedValue(undefined),
  getFromSpaces: jest.fn().mockResolvedValue(Buffer.from("%PDF-scan")),
  deleteSpacesObjectQuietly: jest.fn().mockResolvedValue(undefined),
}));

const spacesMocks = () =>
  jest.requireMock("../src/utils/integrations/spaces.js") as {
    uploadPrivateToSpaces: jest.Mock;
    deleteSpacesObjectQuietly: jest.Mock;
  };

const emailMocks = () =>
  jest.requireMock("../src/utils/integrations/email/emailService.js") as {
    sendDocumentToSign: jest.Mock;
    sendSignedDocument: jest.Mock;
  };

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

const IP = "203.0.113.9";

async function companyWithStaff() {
  const { owner, org } = await setupCompany();
  const staff = await createStaff(app, owner.token, org.id, { fullName: "Ada Obi" });
  return { owner, org, staff };
}

const send = (token: string, orgId: string, staffId: string, template = "nda") =>
  request(app)
    .post(staffPath(orgId, `/${staffId}/documents`))
    .set(authHeader(token))
    .send({ template });

const lastSigningToken = (): string => {
  const calls = emailMocks().sendDocumentToSign.mock.calls as Array<[{ signLink: string }]>;
  const link = calls[calls.length - 1]![0].signLink;
  return link.split("/sign/")[1]!;
};

const openLink = (token: string) => request(app).get(`/v1/staff-documents/${token}`);

const signLink = (token: string, fullName = "Ada N. Obi") =>
  request(app)
    .post(`/v1/staff-documents/${token}/sign`)
    .set("CF-Connecting-IP", IP)
    .send({ fullName, agree: true });

const activityTypes = async (staffId: string) =>
  (await testDataSource.getRepository(StaffActivity).find({ where: { staffId } })).map(
    (row) => row.type
  );

describe("contract templates", () => {
  it("asks for pay first, then fills the offer letter with a future-dated package", async () => {
    const { owner, org, staff } = await companyWithStaff();
    const preview = () =>
      request(app)
        .get(staffPath(org.id, `/${staff.id}/documents/preview?template=offer_letter`))
        .set(authHeader(owner.token));

    expect(apiData<{ preview: { missing: string[] } }>(await preview()).preview.missing).toEqual([
      "pay",
    ]);
    expect((await send(owner.token, org.id, staff.id, "offer_letter")).status).toBe(400);

    await setPay(app, owner.token, org.id, staff.id, { startsOn: "2099-01-01" }).expect(200);
    const filled = apiData<{ preview: { body: string; missing: string[] } }>(
      await preview()
    ).preview;
    expect(filled.missing).toEqual([]);
    expect(filled.body).toContain("Dear Ada Obi,");
    expect(filled.body).toContain(
      "Your base salary is NGN 400,000 per month. This package starts on 1 January 2099."
    );
  });

  it("logs HR reads and refuses people without access", async () => {
    const { owner, org, staff } = await companyWithStaff();
    const plain = await addMember(org);
    const list = (token: string) =>
      request(app)
        .get(staffPath(org.id, `/${staff.id}/documents`))
        .set(authHeader(token));

    expect((await list(plain.token)).status).toBe(403);
    expect((await send(plain.token, org.id, staff.id)).status).toBe(403);
    expect((await list(owner.token)).status).toBe(200);
    expect(
      await testDataSource
        .getRepository(StaffAccessLog)
        .find({ where: { staffId: staff.id, resource: "contract" as never } })
    ).toHaveLength(1);
  });
});

describe("signing", () => {
  it("signs once from the email link, stamps the record and emails both sides", async () => {
    const { owner, org, staff } = await companyWithStaff();
    expect((await send(owner.token, org.id, staff.id)).status).toBe(201);
    expect((await send(owner.token, org.id, staff.id)).status).toBe(409);
    const token = lastSigningToken();

    const opened = apiData<{ document: { title: string; body: string } }>(await openLink(token));
    expect(opened.document.title).toBe("Confidentiality agreement");
    await openLink(token).expect(200);

    const signed = await signLink(token);
    expect(signed.status).toBe(200);
    const { pdfBase64 } = apiData<{ signed: { pdfBase64: string } }>(signed).signed;
    expect(Buffer.from(pdfBase64, "base64").subarray(0, 4).toString()).toBe("%PDF");

    const doc = await testDataSource.getRepository(StaffDocument).findOneOrFail({
      where: { staffId: staff.id },
    });
    expect(doc).toMatchObject({ status: "signed", signerName: "Ada N. Obi", signerIp: IP });
    expect(doc.checkCode).toMatch(/^[a-f0-9]{64}$/);
    expect(emailMocks().sendSignedDocument).toHaveBeenCalledTimes(2);
    expect(await activityTypes(staff.id)).toEqual(
      expect.arrayContaining(["document_sent", "document_viewed", "document_signed"])
    );
    expect(
      (await activityTypes(staff.id)).filter((type) => type === "document_viewed")
    ).toHaveLength(1);

    expect((await openLink(token)).status).toBe(404);
    expect((await signLink(token)).status).toBe(404);

    const pdf = await request(app)
      .get(staffPath(org.id, `/${staff.id}/documents/${doc.id}/pdf`))
      .set(authHeader(owner.token));
    expect(pdf.headers["content-type"]).toBe("application/pdf");
  });

  it("refuses an expired link and kills the old link when sent again", async () => {
    const { owner, org, staff } = await companyWithStaff();
    await send(owner.token, org.id, staff.id).expect(201);
    const firstToken = lastSigningToken();
    const repo = testDataSource.getRepository(StaffDocument);
    const doc = await repo.findOneOrFail({ where: { staffId: staff.id } });

    await repo.update(doc.id, { tokenExpiresAt: new Date(Date.now() - 1000) });
    expect((await openLink(firstToken)).status).toBe(410);
    expect((await signLink(firstToken)).status).toBe(410);

    await request(app)
      .post(staffPath(org.id, `/${staff.id}/documents/${doc.id}/resend`))
      .set(authHeader(owner.token))
      .expect(200);
    const secondToken = lastSigningToken();
    expect((await openLink(firstToken)).status).toBe(404);
    expect((await signLink(secondToken)).status).toBe(200);
  });

  it("lets only one of two simultaneous signatures through", async () => {
    const { owner, org, staff } = await companyWithStaff();
    await send(owner.token, org.id, staff.id).expect(201);
    const token = lastSigningToken();

    const statuses = (await Promise.all([signLink(token), signLink(token)])).map(
      (res) => res.status
    );
    expect(statuses.sort()).toEqual([200, 404]);
  });

  it("keeps the signature when the copy email fails", async () => {
    const { owner, org, staff } = await companyWithStaff();
    await send(owner.token, org.id, staff.id).expect(201);
    emailMocks().sendSignedDocument.mockRejectedValue(new Error("provider down"));

    expect((await signLink(lastSigningToken())).status).toBe(200);
    expect(
      (
        await testDataSource
          .getRepository(StaffDocument)
          .findOneOrFail({ where: { staffId: staff.id } })
      ).status
    ).toBe("signed");
  });

  it("refuses to sign once employment has ended", async () => {
    const { owner, org, staff } = await companyWithStaff();
    await send(owner.token, org.id, staff.id).expect(201);
    const token = lastSigningToken();
    await request(app)
      .post(staffPath(org.id, `/${staff.id}/end`))
      .set(authHeader(owner.token))
      .send({ endDate: today() })
      .expect(200);

    expect((await signLink(token)).status).toBe(410);
  });
});

describe("notarization", () => {
  const scanPath = (orgId: string, staffId: string, docId: string) =>
    staffPath(orgId, `/${staffId}/documents/${docId}/notarized-scan`);

  it("attaches a notarized scan to a signed document and replaces it cleanly", async () => {
    const { owner, org, staff } = await companyWithStaff();
    const other = await setupCompany("Other Ltd");
    await send(owner.token, org.id, staff.id).expect(201);
    const token = lastSigningToken();
    const doc = await testDataSource
      .getRepository(StaffDocument)
      .findOneOrFail({ where: { staffId: staff.id } });
    const flag = (needsNotarization: boolean, orgId = org.id, auth = owner.token) =>
      request(app)
        .patch(staffPath(orgId, `/${staff.id}/documents/${doc.id}`))
        .set(authHeader(auth))
        .send({ needsNotarization });
    const attach = (contentType: string) =>
      request(app)
        .post(scanPath(org.id, staff.id, doc.id))
        .set(authHeader(owner.token))
        .attach("file", Buffer.from("scan"), { filename: "scan.pdf", contentType });

    expect((await flag(true)).status).toBe(409);
    await signLink(token).expect(200);
    expect((await flag(true, other.org.id, other.owner.token)).status).toBe(404);
    expect((await attach("application/pdf")).status).toBe(409);
    await flag(true).expect(200);
    expect((await attach("text/plain")).status).toBe(400);

    await attach("application/pdf").expect(200);
    const firstKey = (
      spacesMocks().uploadPrivateToSpaces.mock.calls as Array<[Buffer, string]>
    )[0]![1];
    await attach("image/png").expect(200);
    expect(spacesMocks().deleteSpacesObjectQuietly).toHaveBeenCalledWith(
      firstKey,
      expect.any(String)
    );
    expect((await flag(false)).status).toBe(409);
    expect(await activityTypes(staff.id)).toContain("document_notarized");

    const scan = await request(app)
      .get(scanPath(org.id, staff.id, doc.id))
      .set(authHeader(owner.token));
    expect(scan.status).toBe(200);
    expect(scan.headers["content-type"]).toBe("image/png");
  });
});
