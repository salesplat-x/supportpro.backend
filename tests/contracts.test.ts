import { createHash } from "crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  startTestDatabase,
  stopTestDatabase,
  clearAllTables,
  testDataSource,
} from "./helpers/db.js";
import { StaffAccessLog, StaffActivity, StaffDocument } from "../src/entities";
import { StaffAccessResource } from "../src/entities/StaffAccessLog.js";
import { checkCodeOf, reconcileDueDocumentFinalization } from "../src/services/contracts.js";
import { apiData } from "./helpers/http.js";
import { addMember, authHeader, setupCompany } from "./helpers/company.js";
import { createStaff, sendDocumentFor, setPay, staffPath, today } from "./helpers/staff.js";

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
    getFromSpaces: jest.Mock;
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
  sendDocumentFor(app, token, orgId, staffId, template);

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
    expect((await send(owner.token, org.id, staff.id)).status).toBe(200);
    expect((await send(owner.token, org.id, staff.id)).status).toBe(409);
    const token = lastSigningToken();

    const opened = apiData<{
      document: { title: string; body: string; dateLabel: string; companyEmail: string | null };
    }>(await openLink(token));
    expect(opened.document.title).toBe("Non-disclosure agreement");
    expect(opened.document).toMatchObject({
      dateLabel: expect.stringMatching(/^\d{1,2} \w+ \d{4}$/),
      companyEmail: expect.any(String),
    });
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

  it("writes one access log line for every view of the email link", async () => {
    const { owner, org, staff } = await companyWithStaff();
    expect((await send(owner.token, org.id, staff.id)).status).toBe(200);
    const token = lastSigningToken();

    await openLink(token).set("CF-Connecting-IP", IP).expect(200);
    await openLink(token).set("CF-Connecting-IP", IP).expect(200);

    const lines = await testDataSource
      .getRepository(StaffAccessLog)
      .find({ where: { staffId: staff.id, resource: StaffAccessResource.Contract } });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ actorId: null, actorName: "Ada Obi (email link)", ip: IP });
    expect(
      (await activityTypes(staff.id)).filter((type) => type === "document_viewed")
    ).toHaveLength(1);
  });

  it("returns no document when the view cannot be logged", async () => {
    const { owner, org, staff } = await companyWithStaff();
    expect((await send(owner.token, org.id, staff.id)).status).toBe(200);
    const token = lastSigningToken();
    await testDataSource.query(`ALTER TABLE staff_access_logs RENAME TO staff_access_logs_gone`);
    try {
      const res = await openLink(token);
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain("confidentiality");
    } finally {
      await testDataSource.query(`ALTER TABLE staff_access_logs_gone RENAME TO staff_access_logs`);
    }
    const doc = await testDataSource
      .getRepository(StaffDocument)
      .findOneOrFail({ where: { staffId: staff.id } });
    expect(doc.openedAt).toBeNull();
  });

  it("refuses an expired link and kills the old link when sent again", async () => {
    const { owner, org, staff } = await companyWithStaff();
    expect((await send(owner.token, org.id, staff.id)).status).toBe(200);
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
    expect((await send(owner.token, org.id, staff.id)).status).toBe(200);
    const token = lastSigningToken();

    const statuses = (await Promise.all([signLink(token), signLink(token)])).map(
      (res) => res.status
    );
    expect(statuses.sort()).toEqual([200, 404]);
  });

  it("keeps the signature when the copy email fails", async () => {
    const { owner, org, staff } = await companyWithStaff();
    expect((await send(owner.token, org.id, staff.id)).status).toBe(200);
    emailMocks()
      .sendSignedDocument.mockRejectedValueOnce(new Error("provider down"))
      .mockRejectedValueOnce(new Error("provider down"));

    const signed = await signLink(lastSigningToken());
    expect(signed.status).toBe(200);
    expect(signed.body.data.signed.copyPending).toBe(true);
    expect(signed.body.data.signed.pdfBase64).not.toBeNull();
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
    expect((await send(owner.token, org.id, staff.id)).status).toBe(200);
    const token = lastSigningToken();
    await request(app)
      .post(staffPath(org.id, `/${staff.id}/end`))
      .set(authHeader(owner.token))
      .send({ endDate: today() })
      .expect(200);

    expect((await signLink(token)).status).toBe(410);
  });
});

describe("finishing a signed document", () => {
  const signedDoc = async (staffId: string) =>
    testDataSource.getRepository(StaffDocument).findOneOrFail({ where: { staffId } });

  const sentAndSigned = async () => {
    const company = await companyWithStaff();
    expect((await send(company.owner.token, company.org.id, company.staff.id)).status).toBe(200);
    const res = await signLink(lastSigningToken());
    return { ...company, res };
  };

  /** Makes the row due for the sweep, whatever delay or backoff was set. */
  const makeDue = (id: string) =>
    testDataSource.query(
      `UPDATE staff_documents SET finalize_next_retry_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [id]
    );

  it("stores one file with its hash, emails both sides once and finishes", async () => {
    const { staff, res } = await sentAndSigned();
    const doc = await signedDoc(staff.id);
    const [[stored, key]] = spacesMocks().uploadPrivateToSpaces.mock.calls as [[Buffer, string]];

    expect(res.body.data.signed.copyPending).toBe(false);
    expect(Buffer.from(res.body.data.signed.pdfBase64, "base64").equals(stored)).toBe(true);
    expect(doc.signedFileKey).toBe(key);
    expect(doc.signedFileHash).toBe(createHash("sha256").update(stored).digest("hex"));
    expect(doc.checkCodeVersion).toBe(2);
    expect(doc.finalizedAt).not.toBeNull();
    expect(doc.finalizeNextRetryAt).toBeNull();

    await reconcileDueDocumentFinalization();
    expect(spacesMocks().uploadPrivateToSpaces).toHaveBeenCalledTimes(1);
    expect(emailMocks().sendSignedDocument).toHaveBeenCalledTimes(2);
  });

  it("serves the stored bytes, not a rebuilt file, on every download", async () => {
    const { owner, org, staff } = await sentAndSigned();
    const doc = await signedDoc(staff.id);
    spacesMocks().getFromSpaces.mockResolvedValueOnce(Buffer.from("%PDF-the-stored-file"));

    const pdf = await request(app)
      .get(staffPath(org.id, `/${staff.id}/documents/${doc.id}/pdf`))
      .set(authHeader(owner.token))
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).toString()).toBe("%PDF-the-stored-file");
  });

  it("errors instead of rebuilding when the stored file can't be read", async () => {
    const { owner, org, staff } = await sentAndSigned();
    const doc = await signedDoc(staff.id);
    spacesMocks().getFromSpaces.mockRejectedValueOnce(new Error("storage down"));

    const pdf = await request(app)
      .get(staffPath(org.id, `/${staff.id}/documents/${doc.id}/pdf`))
      .set(authHeader(owner.token));
    expect(pdf.status).toBe(500);
  });

  it("keeps the signature when storage is down, then the sweep recovers it", async () => {
    const company = await companyWithStaff();
    expect((await send(company.owner.token, company.org.id, company.staff.id)).status).toBe(200);
    spacesMocks().uploadPrivateToSpaces.mockRejectedValueOnce(new Error("storage down"));

    const res = await signLink(lastSigningToken());
    expect(res.status).toBe(200);
    expect(res.body.data.signed).toMatchObject({ pdfBase64: null, copyPending: true });
    let doc = await signedDoc(company.staff.id);
    expect(doc).toMatchObject({ status: "signed", finalizeAttempts: 1, signedFileKey: null });
    expect(doc.finalizeError).toContain("storage down");
    expect(emailMocks().sendSignedDocument).not.toHaveBeenCalled();

    const download = await request(app)
      .get(staffPath(company.org.id, `/${company.staff.id}/documents/${doc.id}/pdf`))
      .set(authHeader(company.owner.token));
    expect(download.status).toBe(409);

    await makeDue(doc.id);
    await reconcileDueDocumentFinalization();
    doc = await signedDoc(company.staff.id);
    expect(doc.finalizedAt).not.toBeNull();
    expect(doc.signedFileKey).not.toBeNull();
    expect(emailMocks().sendSignedDocument).toHaveBeenCalledTimes(2);
  });

  it("does not wait for the sweep's delay before retrying", async () => {
    const company = await companyWithStaff();
    expect((await send(company.owner.token, company.org.id, company.staff.id)).status).toBe(200);
    spacesMocks().uploadPrivateToSpaces.mockRejectedValueOnce(new Error("storage down"));
    await signLink(lastSigningToken()).expect(200);

    await reconcileDueDocumentFinalization();
    expect(spacesMocks().uploadPrivateToSpaces).toHaveBeenCalledTimes(1);
  });

  it("resends only the copy that failed", async () => {
    const company = await companyWithStaff();
    expect((await send(company.owner.token, company.org.id, company.staff.id)).status).toBe(200);
    emailMocks().sendSignedDocument.mockImplementation(({ email }: { email: string }) =>
      email === company.staff.email ? Promise.resolve() : Promise.reject(new Error("bounced"))
    );

    await signLink(lastSigningToken()).expect(200);
    let doc = await signedDoc(company.staff.id);
    expect(doc.employeeCopySentAt).not.toBeNull();
    expect(doc.companyCopySentAt).toBeNull();
    expect(doc.finalizedAt).toBeNull();

    emailMocks().sendSignedDocument.mockReset();
    emailMocks().sendSignedDocument.mockResolvedValue(undefined);
    await makeDue(doc.id);
    await reconcileDueDocumentFinalization();

    const calls = emailMocks().sendSignedDocument.mock.calls as Array<[{ email: string }]>;
    expect(calls.map(([copy]) => copy.email)).toEqual([company.owner.user.email]);
    doc = await signedDoc(company.staff.id);
    expect(doc.finalizedAt).not.toBeNull();
    expect(spacesMocks().uploadPrivateToSpaces).toHaveBeenCalledTimes(1);
  });

  it("uses a stable idempotency key per document and recipient", async () => {
    const { staff } = await sentAndSigned();
    const doc = await signedDoc(staff.id);
    const calls = emailMocks().sendSignedDocument.mock.calls as Array<
      [{ email: string; idempotencyKey: string }]
    >;
    for (const [copy] of calls) {
      expect(copy.idempotencyKey).toBe(`signed-copy/${doc.id}/${copy.email}`);
    }
  });

  it("lets only one of the request and the sweep finish the document", async () => {
    const company = await companyWithStaff();
    expect((await send(company.owner.token, company.org.id, company.staff.id)).status).toBe(200);
    spacesMocks().uploadPrivateToSpaces.mockRejectedValueOnce(new Error("storage down"));
    await signLink(lastSigningToken()).expect(200);
    const doc = await signedDoc(company.staff.id);
    await makeDue(doc.id);

    await Promise.all([
      reconcileDueDocumentFinalization(),
      reconcileDueDocumentFinalization(),
      reconcileDueDocumentFinalization(),
    ]);
    expect(spacesMocks().uploadPrivateToSpaces).toHaveBeenCalledTimes(2);
    expect(emailMocks().sendSignedDocument).toHaveBeenCalledTimes(2);
  });

  it("keeps the first hash when a second upload races it, and deletes the loser", async () => {
    const company = await companyWithStaff();
    expect((await send(company.owner.token, company.org.id, company.staff.id)).status).toBe(200);
    const repo = testDataSource.getRepository(StaffDocument);
    spacesMocks().uploadPrivateToSpaces.mockImplementationOnce(async () => {
      const raced = await repo.findOneOrFail({ where: { staffId: company.staff.id } });
      await repo.update(raced.id, {
        signedFileKey: "signed-documents/first",
        signedFileHash: "a".repeat(64),
      });
    });

    await signLink(lastSigningToken()).expect(200);
    const doc = await signedDoc(company.staff.id);
    expect(doc).toMatchObject({
      signedFileKey: "signed-documents/first",
      signedFileHash: "a".repeat(64),
    });
    const [[, loserKey]] = spacesMocks().uploadPrivateToSpaces.mock.calls as [[Buffer, string]];
    expect(spacesMocks().deleteSpacesObjectQuietly).toHaveBeenCalledWith(
      loserKey,
      expect.any(String)
    );
  });

  it("retakes a stale claim left by a crash, but not a fresh one", async () => {
    const company = await companyWithStaff();
    expect((await send(company.owner.token, company.org.id, company.staff.id)).status).toBe(200);
    spacesMocks().uploadPrivateToSpaces.mockRejectedValueOnce(new Error("storage down"));
    await signLink(lastSigningToken()).expect(200);
    const doc = await signedDoc(company.staff.id);
    await makeDue(doc.id);

    await testDataSource.query(
      `UPDATE staff_documents SET finalize_locked_at = NOW() WHERE id = $1`,
      [doc.id]
    );
    await reconcileDueDocumentFinalization();
    expect((await signedDoc(company.staff.id)).finalizedAt).toBeNull();

    await testDataSource.query(
      `UPDATE staff_documents SET finalize_locked_at = NOW() - INTERVAL '6 minutes' WHERE id = $1`,
      [doc.id]
    );
    await reconcileDueDocumentFinalization();
    expect((await signedDoc(company.staff.id)).finalizedAt).not.toBeNull();
  });

  it("stops after five attempts, records it, and Try again recovers it", async () => {
    const company = await companyWithStaff();
    expect((await send(company.owner.token, company.org.id, company.staff.id)).status).toBe(200);
    spacesMocks().uploadPrivateToSpaces.mockRejectedValue(new Error("storage down"));
    await signLink(lastSigningToken()).expect(200);
    const doc = await signedDoc(company.staff.id);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await makeDueIfPending(doc.id);
      await reconcileDueDocumentFinalization();
    }
    expect(spacesMocks().uploadPrivateToSpaces).toHaveBeenCalledTimes(5);
    expect(await signedDoc(company.staff.id)).toMatchObject({
      finalizeAttempts: 5,
      finalizeNextRetryAt: null,
    });
    expect(await activityTypes(company.staff.id)).toContain("document_copy_failed");

    const list = await request(app)
      .get(staffPath(company.org.id, `/${company.staff.id}/documents`))
      .set(authHeader(company.owner.token));
    expect(list.body.data.documents[0].copyStatus).toBe("failed");

    const retryPath = staffPath(
      company.org.id,
      `/${company.staff.id}/documents/${doc.id}/finalize`
    );
    const stranger = await setupCompany("Other Ltd");
    expect((await request(app).post(retryPath).set(authHeader(stranger.owner.token))).status).toBe(
      403
    );

    spacesMocks().uploadPrivateToSpaces.mockReset();
    spacesMocks().uploadPrivateToSpaces.mockResolvedValue(undefined);
    const retry = await request(app).post(retryPath).set(authHeader(company.owner.token));
    expect(retry.status).toBe(200);
    expect(retry.body.data.document.copyStatus).toBe("done");

    const again = await request(app).post(retryPath).set(authHeader(company.owner.token));
    expect(again.status).toBe(200);
    expect(spacesMocks().uploadPrivateToSpaces).toHaveBeenCalledTimes(1);
  });

  const makeDueIfPending = (id: string) =>
    testDataSource.query(
      `UPDATE staff_documents SET finalize_next_retry_at = NOW() - INTERVAL '1 second'
       WHERE id = $1 AND finalize_next_retry_at IS NOT NULL`,
      [id]
    );

  it("still finishes when employment ended after signing", async () => {
    const company = await companyWithStaff();
    expect((await send(company.owner.token, company.org.id, company.staff.id)).status).toBe(200);
    spacesMocks().uploadPrivateToSpaces.mockRejectedValueOnce(new Error("storage down"));
    await signLink(lastSigningToken()).expect(200);
    await request(app)
      .post(staffPath(company.org.id, `/${company.staff.id}/end`))
      .set(authHeader(company.owner.token))
      .send({ endDate: today() })
      .expect(200);
    const doc = await signedDoc(company.staff.id);
    await makeDue(doc.id);

    await reconcileDueDocumentFinalization();
    expect((await signedDoc(company.staff.id)).finalizedAt).not.toBeNull();
  });

  it("sends the company copy to the creator, even if a teammate sent the contract", async () => {
    const { owner, org } = await setupCompany();
    const hr = await addMember(org, { canManagePeople: true });
    const staff = await createStaff(app, owner.token, org.id, { fullName: "Ada Obi" });
    expect((await send(owner.token, org.id, staff.id)).status).toBe(200);
    const token = lastSigningToken();
    await testDataSource.query(`UPDATE staff_documents SET sent_by_id = $1 WHERE staff_id = $2`, [
      hr.user.id,
      staff.id,
    ]);

    await signLink(token).expect(200);

    const emails = (emailMocks().sendSignedDocument.mock.calls as Array<[{ email: string }]>).map(
      ([copy]) => copy.email
    );
    expect(emails).toContain(owner.user.email);
    expect(emails).not.toContain(hr.user.email);
  });

  it("keeps contracts from a member with Can manage people", async () => {
    const { owner, org } = await setupCompany();
    const hr = await addMember(org, { canManagePeople: true });
    const staff = await createStaff(app, owner.token, org.id, { fullName: "Ada Obi" });

    expect((await send(hr.token, org.id, staff.id)).status).toBe(403);
    const list = await request(app)
      .get(staffPath(org.id, `/${staff.id}/documents`))
      .set(authHeader(hr.token));
    expect(list.status).toBe(403);
  });

  it("leaves documents signed before this change alone", async () => {
    const { owner, org, staff } = await sentAndSigned();
    const doc = await signedDoc(staff.id);
    await testDataSource.getRepository(StaffDocument).update(doc.id, {
      checkCodeVersion: 1,
      checkStamp: null,
      signedFileKey: null,
      signedFileHash: null,
      finalizedAt: null,
      finalizeNextRetryAt: new Date(Date.now() - 1000),
    });
    jest.clearAllMocks();

    await reconcileDueDocumentFinalization();
    expect(emailMocks().sendSignedDocument).not.toHaveBeenCalled();
    expect(spacesMocks().uploadPrivateToSpaces).not.toHaveBeenCalled();

    const pdf = await request(app)
      .get(staffPath(org.id, `/${staff.id}/documents/${doc.id}/pdf`))
      .set(authHeader(owner.token));
    expect(pdf.status).toBe(200);
    expect(spacesMocks().getFromSpaces).not.toHaveBeenCalled();
    const list = await request(app)
      .get(staffPath(org.id, `/${staff.id}/documents`))
      .set(authHeader(owner.token));
    expect(list.body.data.documents[0].copyStatus).toBe("done");
  });
});

describe("checking a signed document", () => {
  const signedPdfAndDoc = async () => {
    const company = await companyWithStaff();
    expect((await send(company.owner.token, company.org.id, company.staff.id)).status).toBe(200);
    await signLink(lastSigningToken()).expect(200);
    const doc = await testDataSource
      .getRepository(StaffDocument)
      .findOneOrFail({ where: { staffId: company.staff.id } });
    const [[pdf]] = spacesMocks().uploadPrivateToSpaces.mock.calls as [[Buffer, string]];
    return { ...company, doc, pdf };
  };

  const checkCode = (documentId: string, checkCode: string) =>
    request(app).post("/v1/document-checks").send({ documentId, checkCode });

  const checkFile = (file: Buffer, contentType = "application/pdf") =>
    request(app)
      .post("/v1/document-checks/file")
      .attach("file", file, { filename: "signed.pdf", contentType });

  it("confirms the right code with a limited summary and logs the check", async () => {
    const { doc, staff } = await signedPdfAndDoc();
    const res = await checkCode(doc.id, doc.checkCode!.toUpperCase()).set("CF-Connecting-IP", IP);

    expect(res.status).toBe(200);
    expect(res.body.data.check).toMatchObject({
      result: "verified",
      companyName: expect.any(String),
      title: "Non-disclosure agreement",
      signerName: "Ada N. Obi",
    });
    expect(JSON.stringify(res.body)).not.toContain(IP);
    expect(JSON.stringify(res.body)).not.toContain(doc.bodyText.slice(0, 30));
    const lines = await testDataSource
      .getRepository(StaffAccessLog)
      .find({ where: { staffId: staff.id, actorName: "Document check page" } });
    expect(lines).toHaveLength(1);
  });

  it("gives the same reply for a wrong code, an unknown id and an unknown file", async () => {
    const { doc, pdf } = await signedPdfAndDoc();
    const changedFile = Buffer.concat([pdf, Buffer.from(" ")]);

    const replies = await Promise.all([
      checkCode(doc.id, "a".repeat(64)),
      checkCode("7c9e6679-7425-40de-944b-e07fc1f90ae7", doc.checkCode!),
      checkFile(changedFile),
    ]);
    expect(replies.map((res) => res.status)).toEqual([404, 404, 404]);
    expect(new Set(replies.map((res) => res.body.error.message)).size).toBe(1);
    expect(
      await testDataSource
        .getRepository(StaffAccessLog)
        .count({ where: { actorName: "Document check page" } })
    ).toBe(0);
  });

  it("confirms the exact stored file", async () => {
    const { pdf } = await signedPdfAndDoc();
    const res = await checkFile(pdf);
    expect(res.status).toBe(200);
    expect(res.body.data.check.result).toBe("verified");
  });

  it("flags a stored record that no longer matches its code", async () => {
    const { doc } = await signedPdfAndDoc();
    await testDataSource.getRepository(StaffDocument).update(doc.id, { bodyText: "Changed terms" });
    const res = await checkCode(doc.id, doc.checkCode!);
    expect(res.status).toBe(200);
    expect(res.body.data.check.result).toBe("changed");
  });

  it("gives older documents a limited check and never calls them changed", async () => {
    const { doc } = await signedPdfAndDoc();
    await testDataSource
      .getRepository(StaffDocument)
      .update(doc.id, { checkCodeVersion: 1, checkStamp: null });
    const res = await checkCode(doc.id, doc.checkCode!);
    expect(res.status).toBe(200);
    expect(res.body.data.check.result).toBe("limited");
  });

  it("never matches a document that is not signed yet", async () => {
    const company = await companyWithStaff();
    expect((await send(company.owner.token, company.org.id, company.staff.id)).status).toBe(200);
    const doc = await testDataSource
      .getRepository(StaffDocument)
      .findOneOrFail({ where: { staffId: company.staff.id } });
    expect((await checkCode(doc.id, "a".repeat(64))).status).toBe(404);
  });

  it("refuses bad input, other file types and files over 5 MB", async () => {
    expect((await checkCode("not-a-uuid", "a".repeat(64))).status).toBe(400);
    expect((await checkCode("7c9e6679-7425-40de-944b-e07fc1f90ae7", "short")).status).toBe(400);
    expect((await checkFile(Buffer.from("x"), "text/plain")).status).toBe(400);
    expect((await checkFile(Buffer.alloc(5 * 1024 * 1024 + 1))).status).toBe(400);
    expect((await checkFile(Buffer.alloc(5 * 1024 * 1024))).status).toBe(404);
  });

  it("cannot be tricked by moving text between fields", async () => {
    const { doc } = await signedPdfAndDoc();
    const shifted = {
      ...doc,
      title: `${doc.title}\n${doc.bodyText}`,
      bodyText: "",
    } as StaffDocument;
    expect(checkCodeOf(shifted)).not.toBe(doc.checkCode);
  });
});

describe("notarization", () => {
  const scanPath = (orgId: string, staffId: string, docId: string) =>
    staffPath(orgId, `/${staffId}/documents/${docId}/notarized-scan`);

  it("attaches a notarized scan to a signed document and replaces it cleanly", async () => {
    const { owner, org, staff } = await companyWithStaff();
    const other = await setupCompany("Other Ltd");
    expect((await send(owner.token, org.id, staff.id)).status).toBe(200);
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
    const firstKey = (spacesMocks().uploadPrivateToSpaces.mock.calls as Array<[Buffer, string]>)
      .map(([, key]) => key)
      .find((key) => key.startsWith("notarized-scans/"))!;
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

describe("drafts, fields and statuses", () => {
  const docsPath = (orgId: string, staffId: string, suffix = "") =>
    staffPath(orgId, `/${staffId}/documents${suffix}`);
  const draft = (
    token: string,
    orgId: string,
    staffId: string,
    body: Record<string, unknown> = { template: "nda" }
  ) => request(app).post(docsPath(orgId, staffId)).set(authHeader(token)).send(body);

  it("saves a draft without emailing anyone and replaces it when saved again", async () => {
    const { owner, org, staff } = await companyWithStaff();
    const first = await draft(owner.token, org.id, staff.id, { template: "pay_agreement" });
    expect(first.status).toBe(201);
    expect(first.body.data.document).toMatchObject({
      status: "draft",
      displayStatus: "draft",
      sentAt: null,
      title: "Pay agreement",
    });
    const second = await draft(owner.token, org.id, staff.id, {
      template: "pay_agreement",
      jobTitle: "Lead Designer",
      startDate: "2027-02-03",
      managerName: "Tunde Bakare",
    });
    expect(second.body.data.document.id).toBe(first.body.data.document.id);
    expect(second.body.data.document.fields).toEqual({
      jobTitle: "Lead Designer",
      startDate: "2027-02-03",
      managerName: "Tunde Bakare",
    });
    expect(second.body.data.preview.body).toContain("Lead Designer");
    expect(second.body.data.preview.body).toContain("3 February 2027");
    expect(await testDataSource.getRepository(StaffDocument).count()).toBe(1);
    expect(emailMocks().sendDocumentToSign).not.toHaveBeenCalled();
  });

  it("uses the typed fields for that document only, not the staff record", async () => {
    const { owner, org, staff } = await companyWithStaff();
    await setPay(app, owner.token, org.id, staff.id, {}).expect(200);
    const saved = await draft(owner.token, org.id, staff.id, {
      template: "pay_agreement",
      jobTitle: "Lead Designer",
    });
    await request(app)
      .post(docsPath(org.id, staff.id, `/${saved.body.data.document.id}/send`))
      .set(authHeader(owner.token))
      .expect(200);
    const doc = await testDataSource
      .getRepository(StaffDocument)
      .findOneByOrFail({ staffId: staff.id });
    expect(doc.bodyText).toContain("Lead Designer");
    const record = await request(app)
      .get(staffPath(org.id, `/${staff.id}`))
      .set(authHeader(owner.token));
    expect(JSON.stringify(record.body)).not.toContain("Lead Designer");
  });

  it("rejects a bad date and a template outside the four", async () => {
    const { owner, org, staff } = await companyWithStaff();
    expect(
      (await draft(owner.token, org.id, staff.id, { template: "nda", startDate: "soon" })).status
    ).toBe(400);
    expect((await draft(owner.token, org.id, staff.id, { template: "lease" })).status).toBe(400);
  });

  it("sends a draft once, refuses to send it twice and blocks an offer letter without pay", async () => {
    const { owner, org, staff } = await companyWithStaff();
    const offer = await draft(owner.token, org.id, staff.id, { template: "offer_letter" });
    const send = (id: string) =>
      request(app)
        .post(docsPath(org.id, staff.id, `/${id}/send`))
        .set(authHeader(owner.token));
    expect((await send(offer.body.data.document.id)).status).toBe(400);

    const nda = await draft(owner.token, org.id, staff.id);
    const id = nda.body.data.document.id as string;
    const sent = await send(id);
    expect(sent.status).toBe(200);
    expect(sent.body.data.document.status).toBe("sent");
    expect((await send(id)).status).toBe(409);
  });

  it("reads one document with its preview, logged, and deletes only drafts", async () => {
    const { owner, org, staff } = await companyWithStaff();
    const saved = await draft(owner.token, org.id, staff.id);
    const id = saved.body.data.document.id as string;
    const read = await request(app)
      .get(docsPath(org.id, staff.id, `/${id}`))
      .set(authHeader(owner.token));
    expect(read.status).toBe(200);
    expect(read.body.data.preview.body).toContain("Ada Obi");
    const sent = await request(app)
      .post(docsPath(org.id, staff.id, `/${id}/send`))
      .set(authHeader(owner.token));
    expect(sent.status).toBe(200);
    const del = await request(app)
      .delete(docsPath(org.id, staff.id, `/${id}`))
      .set(authHeader(owner.token));
    expect(del.status).toBe(409);
    const another = await draft(owner.token, org.id, staff.id, { template: "work_ownership" });
    const gone = await request(app)
      .delete(docsPath(org.id, staff.id, `/${another.body.data.document.id}`))
      .set(authHeader(owner.token));
    expect(gone.status).toBe(200);
  });

  it("lets the employee decline, shows Declined and lets HR send it again", async () => {
    const { owner, org, staff } = await companyWithStaff();
    expect((await send(owner.token, org.id, staff.id)).status).toBe(200);
    const token = lastSigningToken();
    await request(app).post(`/v1/staff-documents/${token}/decline`).expect(200);
    const doc = await testDataSource
      .getRepository(StaffDocument)
      .findOneByOrFail({ staffId: staff.id });
    expect(doc.status).toBe("declined");
    expect(doc.declinedAt).not.toBeNull();
    expect(doc.tokenHash).toBeNull();
    expect(await activityTypes(staff.id)).toContain("document_declined");
    expect((await openLink(token)).status).toBe(404);
    expect((await signLink(token)).status).toBe(404);

    const list = await request(app).get(docsPath(org.id, staff.id)).set(authHeader(owner.token));
    expect(list.body.data.documents[0].displayStatus).toBe("declined");
    const again = await request(app)
      .post(docsPath(org.id, staff.id, `/${doc.id}/resend`))
      .set(authHeader(owner.token));
    expect(again.status).toBe(200);
    expect(again.body.data.document).toMatchObject({ status: "sent", declinedAt: null });
    expect((await signLink(lastSigningToken())).status).toBe(200);
  });

  it("shows To notarize, then Notarized with the scan name and who uploaded it", async () => {
    const { owner, org, staff } = await companyWithStaff();
    expect((await send(owner.token, org.id, staff.id)).status).toBe(200);
    await signLink(lastSigningToken()).expect(200);
    const doc = await testDataSource
      .getRepository(StaffDocument)
      .findOneByOrFail({ staffId: staff.id });
    const statusOf = async () =>
      (await request(app).get(docsPath(org.id, staff.id)).set(authHeader(owner.token))).body.data
        .documents[0];
    expect((await statusOf()).displayStatus).toBe("signed");
    await request(app)
      .patch(docsPath(org.id, staff.id, `/${doc.id}`))
      .set(authHeader(owner.token))
      .send({ needsNotarization: true })
      .expect(200);
    expect((await statusOf()).displayStatus).toBe("to_notarize");
    await request(app)
      .post(docsPath(org.id, staff.id, `/${doc.id}/notarized-scan`))
      .set(authHeader(owner.token))
      .attach("file", Buffer.from("scan"), {
        filename: "nda_notarized.pdf",
        contentType: "application/pdf",
      })
      .expect(200);
    const row = await statusOf();
    expect(row).toMatchObject({
      displayStatus: "notarized",
      notarizedScanName: "nda_notarized.pdf",
      notarizedByName: expect.any(String),
    });
  });

  it("says which company to contact when an expired or used link is opened", async () => {
    const { owner, org, staff } = await companyWithStaff();
    expect((await send(owner.token, org.id, staff.id)).status).toBe(200);
    const token = lastSigningToken();
    await testDataSource
      .getRepository(StaffDocument)
      .update({ staffId: staff.id }, { tokenExpiresAt: new Date(Date.now() - 1000) });
    const res = await openLink(token);
    expect(res.status).toBe(410);
    expect(res.body.error.details).toMatchObject({
      documentTitle: "Non-disclosure agreement",
      companyName: expect.any(String),
    });
  });

  it("keeps drafts away from My work", async () => {
    const { owner, org, staff } = await companyWithStaff();
    const saved = await draft(owner.token, org.id, staff.id);
    const row = await testDataSource
      .getRepository(StaffDocument)
      .findOneByOrFail({ id: saved.body.data.document.id });
    expect(row.tokenHash).toBeNull();
    expect(row.status).toBe("draft");
  });
});
