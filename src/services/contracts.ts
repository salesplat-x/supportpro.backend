import crypto from "crypto";
import { EntityManager } from "typeorm";
import env from "../config/env.js";
import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import { StaffAccessResource } from "../entities/StaffAccessLog.js";
import { StaffActivityType } from "../entities/StaffActivity.js";
import { DocumentStatus, DocumentTemplate, StaffDocument } from "../entities/StaffDocument.js";
import { StaffMember, StaffStatus } from "../entities/StaffMember.js";
import { User } from "../entities/User.js";
import { generateContractPdf } from "../utils/contractPdf.js";
import {
  MAX_DURABLE_ATTEMPTS,
  STALE_LOCK_INTERVAL,
  SWEEP_BATCH_SIZE,
  claimRowById,
  durableFailureUpdate,
  selectDueIds,
} from "../utils/durableJobs.js";
import { renderContract } from "../utils/contractTemplates.js";
import EmailService from "../utils/integrations/email/emailService.js";
import {
  deleteSpacesObjectQuietly,
  getFromSpaces,
  spacesKeyFor,
  uploadPrivateToSpaces,
} from "../utils/integrations/spaces.js";
import logger from "../utils/logger.js";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../utils/errors";
import { INVITE_EXPIRY_DAYS, generateInviteToken } from "./organization.js";
import { assertNotEnded, loadPay, longDate } from "./pay.js";
import { assertCanManagePeople, getPeopleAccess } from "./peopleAccess.js";
import {
  type AccessActor,
  activityEntry,
  logStaffAccess,
  openStaff,
  recordActivities,
} from "./staffAudit.js";
import { hashToken, withTimeout } from "./staffInvite.js";
import { Actor, findStaff, isUniqueViolation } from "./staffRecord.js";

const DAY_MS = 86_400_000;
const EMAIL_TIMEOUT_MS = 10_000;
const LOGO_TIMEOUT_MS = 5_000;
const STORAGE_TIMEOUT_MS = 15_000;
const LINK_GONE = "This link has expired or was already used";
export const CHECK_CODE_VERSION = 2;
const FIRST_SWEEP_DELAY_MS = 2 * 60 * 1000;

export type DocumentCopyStatus = "none" | "pending" | "failed" | "done";

export interface DocumentView {
  id: string;
  template: DocumentTemplate;
  title: string;
  status: DocumentStatus;
  sentAt: Date;
  openedAt: Date | null;
  signedAt: Date | null;
  signerName: string | null;
  linkExpiresAt: Date | null;
  needsNotarization: boolean;
  notarizedAt: Date | null;
  checkCode: string | null;
  copyStatus: DocumentCopyStatus;
}

export interface SigningView {
  companyName: string;
  companyLogoUrl: string | null;
  employeeName: string;
  title: string;
  body: string;
}

export interface SignedCopy {
  fileName: string;
  pdfBase64: string | null;
  copyPending: boolean;
}

const copyStatusOf = (doc: StaffDocument): DocumentCopyStatus => {
  if (doc.status !== DocumentStatus.Signed) return "none";
  if (doc.checkCodeVersion < CHECK_CODE_VERSION || doc.finalizedAt) return "done";
  return doc.finalizeNextRetryAt ? "pending" : "failed";
};

export const toDocumentView = (doc: StaffDocument): DocumentView => ({
  id: doc.id,
  template: doc.template,
  title: doc.title,
  status: doc.status,
  sentAt: doc.sentAt,
  openedAt: doc.openedAt,
  signedAt: doc.signedAt,
  signerName: doc.signerName,
  linkExpiresAt: doc.tokenExpiresAt,
  needsNotarization: doc.needsNotarization,
  notarizedAt: doc.notarizedAt,
  checkCode: doc.checkCode,
  copyStatus: copyStatusOf(doc),
});

const loadOrganization = (organizationId: string): Promise<Organization> =>
  AppDataSource.getRepository(Organization).findOneOrFail({ where: { id: organizationId } });

const documentsRepo = (em: EntityManager = AppDataSource.manager) =>
  em.getRepository(StaffDocument);

const renderFor = async (org: Organization, staff: StaffMember, template: DocumentTemplate) => {
  const pay = await loadPay(staff.id);
  const current = pay.packages.find((pkg) => pkg.id === pay.currentPackageId);
  return renderContract(template, {
    companyName: org.name,
    fullName: staff.fullName,
    jobTitle: staff.jobTitle,
    startDate: longDate(staff.startDate),
    payParagraph: current?.paragraph ?? null,
  });
};

const issueSigningToken = (doc: StaffDocument): string => {
  const token = generateInviteToken();
  doc.tokenHash = hashToken(token);
  doc.tokenExpiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * DAY_MS);
  return token;
};

const findStaffDocument = async (
  em: EntityManager,
  staff: StaffMember,
  documentId: string,
  lock = false
): Promise<StaffDocument> => {
  const doc = await documentsRepo(em).findOne({
    where: { id: documentId, staffId: staff.id, organizationId: staff.organizationId },
    ...(lock ? { lock: { mode: "pessimistic_write" as const } } : {}),
  });
  if (!doc) {
    throw new NotFoundError("Document not found");
  }
  return doc;
};

const fileNameFor = (doc: StaffDocument): string =>
  `${doc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}${doc.status === DocumentStatus.Signed ? "-signed" : ""}.pdf`;

const loadLogo = async (org: Organization): Promise<Buffer | null> => {
  if (!org.logoKey) return null;
  try {
    return await withTimeout(getFromSpaces(org.logoKey), LOGO_TIMEOUT_MS);
  } catch (err) {
    logger.warn(`Contract PDF for ${org.id} is using the company name: ${(err as Error).message}`);
    return null;
  }
};

export const buildDocumentPdf = async (
  org: Organization,
  doc: StaffDocument
): Promise<{ fileName: string; pdf: Buffer }> => {
  const pdf = await generateContractPdf({
    companyName: org.name,
    logo: await loadLogo(org),
    title: doc.title,
    body: doc.bodyText,
    signature:
      doc.status === DocumentStatus.Signed && doc.signedAt
        ? {
            name: doc.signerName ?? "",
            signedAt: doc.signedAt,
            ip: doc.signerIp ?? "",
            checkCode: doc.checkCode ?? "",
            check:
              doc.checkCodeVersion >= CHECK_CODE_VERSION
                ? { documentId: doc.id, verifyUrl: `${env.website}/verify-document` }
                : null,
          }
        : null,
  });
  return { fileName: fileNameFor(doc), pdf };
};

/** Never throws: a failed email is put on the timeline so HR can send again. */
const emailSigningLink = async (
  org: Organization,
  staff: StaffMember,
  doc: StaffDocument,
  token: string,
  actor: Actor
): Promise<boolean> => {
  try {
    if (!env.website) {
      throw new Error("FRONTEND_CALLBACK_URL is not configured");
    }
    await withTimeout(
      new EmailService().sendDocumentToSign({
        email: staff.email,
        firstName: staff.fullName.split(" ")[0] ?? staff.fullName,
        companyName: org.name,
        companyLogoUrl: org.logoUrl,
        documentTitle: doc.title,
        signLink: `${env.website}/sign/${token}`,
      }),
      EMAIL_TIMEOUT_MS
    );
    return true;
  } catch (err) {
    logger.error(`Signing email failed for document ${doc.id}: ${(err as Error).message}`);
    await recordActivities(AppDataSource.manager, staff, [
      activityEntry(StaffActivityType.DocumentEmailFailed, actor, { title: doc.title }),
    ]).catch((recordErr: Error) =>
      logger.error(`Could not record the failed signing email for ${doc.id}: ${recordErr.message}`)
    );
    return false;
  }
};

export const previewDocument = async (
  actor: User,
  organizationId: string,
  staffId: string,
  template: DocumentTemplate,
  ip: string
) => {
  const staff = await openStaff(actor, organizationId, staffId, StaffAccessResource.Contract, ip);
  return renderFor(await loadOrganization(organizationId), staff, template);
};

export const listDocuments = async (
  actor: User,
  organizationId: string,
  staffId: string,
  ip: string
): Promise<DocumentView[]> => {
  await openStaff(actor, organizationId, staffId, StaffAccessResource.Contract, ip);
  const docs = await documentsRepo().find({
    where: { staffId, organizationId },
    order: { sentAt: "DESC" },
  });
  return docs.map(toDocumentView);
};

export const sendDocument = async (
  actor: User,
  organizationId: string,
  staffId: string,
  template: DocumentTemplate
): Promise<{ document: DocumentView; emailSent: boolean }> => {
  const org = await assertCanManagePeople(actor.id, organizationId);
  let token = "";
  let sent: { doc: StaffDocument; staff: StaffMember };
  try {
    sent = await AppDataSource.transaction(async (em) => {
      const staff = await findStaff(organizationId, staffId, { em, lock: true });
      assertNotEnded(staff);
      const rendered = await renderFor(org, staff, template);
      if (rendered.missing.length > 0) {
        throw new ValidationError("Set up pay first. This document includes the pay paragraph.");
      }
      const doc = documentsRepo(em).create({
        organizationId,
        staffId,
        template,
        title: rendered.title,
        bodyText: rendered.body,
        status: DocumentStatus.Sent,
        sentById: actor.id,
        sentAt: new Date(),
      });
      token = issueSigningToken(doc);
      const saved = await documentsRepo(em).save(doc);
      await recordActivities(em, staff, [
        activityEntry(StaffActivityType.DocumentSent, actor, { title: saved.title }),
      ]);
      return { doc: saved, staff };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(
        "This document is already waiting for a signature. Use Send again instead."
      );
    }
    throw err;
  }
  const emailSent = await emailSigningLink(org, sent.staff, sent.doc, token, actor);
  return { document: toDocumentView(sent.doc), emailSent };
};

export const resendDocument = async (
  actor: User,
  organizationId: string,
  staffId: string,
  documentId: string
): Promise<{ document: DocumentView; emailSent: boolean }> => {
  const org = await assertCanManagePeople(actor.id, organizationId);
  let token = "";
  const sent = await AppDataSource.transaction(async (em) => {
    const staff = await findStaff(organizationId, staffId, { em, lock: true });
    assertNotEnded(staff);
    const doc = await findStaffDocument(em, staff, documentId, true);
    if (doc.status !== DocumentStatus.Sent) {
      throw new ConflictError("This document is already signed");
    }
    token = issueSigningToken(doc);
    doc.sentAt = new Date();
    const saved = await documentsRepo(em).save(doc);
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.DocumentSent, actor, { title: saved.title, resent: true }),
    ]);
    return { doc: saved, staff };
  });
  const emailSent = await emailSigningLink(org, sent.staff, sent.doc, token, actor);
  return { document: toDocumentView(sent.doc), emailSent };
};

const sha256 = (content: string | Buffer): string =>
  crypto.createHash("sha256").update(content).digest("hex");

const readStoredFile = (key: string): Promise<Buffer> =>
  withTimeout(getFromSpaces(key), STORAGE_TIMEOUT_MS, "File storage did not respond");

/** A signed document has one file: the copy made when it was signed, byte for byte. */
export const signedDocumentFile = async (
  org: Organization,
  doc: StaffDocument
): Promise<{ fileName: string; pdf: Buffer }> => {
  if (doc.status !== DocumentStatus.Signed || doc.checkCodeVersion < CHECK_CODE_VERSION) {
    return buildDocumentPdf(org, doc);
  }
  if (!doc.signedFileKey) {
    throw new ConflictError("The signed copy is still being prepared. Try again in a minute.");
  }
  return { fileName: fileNameFor(doc), pdf: await readStoredFile(doc.signedFileKey) };
};

export const downloadDocument = async (
  actor: User,
  organizationId: string,
  staffId: string,
  documentId: string,
  ip: string
): Promise<{ fileName: string; pdf: Buffer }> => {
  const staff = await openStaff(actor, organizationId, staffId, StaffAccessResource.Contract, ip);
  const doc = await findStaffDocument(AppDataSource.manager, staff, documentId);
  return signedDocumentFile(await loadOrganization(organizationId), doc);
};

const findByToken = async (
  token: string,
  em: EntityManager = AppDataSource.manager,
  lock = false
): Promise<StaffDocument> => {
  const doc = await documentsRepo(em).findOne({
    where: { tokenHash: hashToken(token), status: DocumentStatus.Sent },
    ...(lock ? { lock: { mode: "pessimistic_write" as const } } : {}),
  });
  if (!doc) {
    throw new NotFoundError(LINK_GONE);
  }
  if (!doc.tokenExpiresAt || doc.tokenExpiresAt.getTime() <= Date.now()) {
    throw new AppError(410, "LINK_EXPIRED", LINK_GONE);
  }
  return doc;
};

/** Every view gets an access log line; the activity timeline keeps only the first, so it stays readable. */
export const recordView = async (
  doc: StaffDocument,
  staff: StaffMember,
  viewer: AccessActor,
  ip: string
): Promise<void> => {
  await AppDataSource.transaction(async (em) => {
    await logStaffAccess({
      organizationId: doc.organizationId,
      actor: viewer,
      staff,
      resource: StaffAccessResource.Contract,
      ip,
      em,
    });
    const opened = await em
      .createQueryBuilder()
      .update(StaffDocument)
      .set({ openedAt: new Date() })
      .where(`"id" = :id AND "opened_at" IS NULL`, { id: doc.id })
      .execute();
    if (opened.affected) {
      await recordActivities(em, staff, [
        {
          type: StaffActivityType.DocumentViewed,
          actorId: staff.userId,
          actorName: staff.fullName,
          meta: { title: doc.title },
        },
      ]);
    }
  });
};

export const signingViewOf = async (
  doc: StaffDocument,
  staff: StaffMember
): Promise<SigningView> => {
  const org = await loadOrganization(doc.organizationId);
  return {
    companyName: org.name,
    companyLogoUrl: org.logoUrl,
    employeeName: staff.fullName,
    title: doc.title,
    body: doc.bodyText,
  };
};

const staffOf = async (doc: StaffDocument, em: EntityManager = AppDataSource.manager) => {
  const staff = await em.getRepository(StaffMember).findOneOrFail({ where: { id: doc.staffId } });
  if (staff.status === StaffStatus.Ended) {
    throw new AppError(410, "LINK_EXPIRED", LINK_GONE);
  }
  return staff;
};

export const openSigningLink = async (token: string, ip: string): Promise<SigningView> => {
  const doc = await findByToken(token);
  const staff = await staffOf(doc);
  await recordView(doc, staff, { id: null, name: `${staff.fullName} (email link)` }, ip);
  return signingViewOf(doc, staff);
};

export const checkCodeOf = (doc: StaffDocument): string =>
  sha256(
    JSON.stringify([
      doc.id,
      doc.title,
      doc.bodyText,
      doc.signerName,
      doc.checkStamp,
      doc.signerIp ?? "",
    ])
  );

/** Shared by the email link and My work. The caller has locked `doc` in `em`. */
export const signLockedDocument = async (
  em: EntityManager,
  doc: StaffDocument,
  signerName: string,
  ip: string
): Promise<{ doc: StaffDocument; staff: StaffMember }> => {
  const staff = await staffOf(doc, em);
  const signedAt = new Date();
  Object.assign(doc, {
    status: DocumentStatus.Signed,
    signedAt,
    signerName,
    signerIp: ip || null,
    checkCodeVersion: CHECK_CODE_VERSION,
    checkStamp: signedAt.toISOString(),
    finalizeNextRetryAt: new Date(signedAt.getTime() + FIRST_SWEEP_DELAY_MS),
    tokenHash: null,
    tokenExpiresAt: null,
  });
  doc.checkCode = checkCodeOf(doc);
  const signed = await documentsRepo(em).save(doc);
  await recordActivities(em, staff, [
    {
      type: StaffActivityType.DocumentSigned,
      actorId: staff.userId,
      actorName: signerName,
      meta: { title: signed.title },
    },
  ]);
  return { doc: signed, staff };
};

/** Whoever sent it, unless they have since lost access to People: then the company owner. */
const companyCopyRecipient = async (org: Organization, doc: StaffDocument) => {
  const users = AppDataSource.getRepository(User);
  const select = { id: true, email: true, firstName: true };
  const sender = doc.sentById ? await users.findOne({ where: { id: doc.sentById }, select }) : null;
  const stillHasAccess = sender
    ? await getPeopleAccess(sender.id, org.id).then(
        (access) => access.canManagePeople,
        () => false
      )
    : false;
  if (sender && stillHasAccess) return sender;
  return org.ownerId ? users.findOne({ where: { id: org.ownerId }, select }) : null;
};

const COPY_SENT_COLUMNS = {
  employee: "employeeCopySentAt",
  company: "companyCopySentAt",
} as const;

/** Only sends the copies still owed, so a retry never repeats one that already went out. */
const emailMissingCopies = async (
  org: Organization,
  doc: StaffDocument,
  staff: StaffMember,
  copy: { fileName: string; pdf: Buffer }
): Promise<void> => {
  const company = doc.companyCopySentAt ? null : await companyCopyRecipient(org, doc);
  const owed = [
    {
      side: "employee" as const,
      sent: doc.employeeCopySentAt,
      email: staff.email,
      firstName: staff.fullName.split(" ")[0] ?? staff.fullName,
    },
    {
      side: "company" as const,
      sent: doc.companyCopySentAt,
      email: company?.email,
      firstName: company?.firstName,
    },
  ].filter((copyTo) => !copyTo.sent && copyTo.email);

  const results = await Promise.allSettled(
    owed.map(async ({ side, email, firstName }) => {
      await withTimeout(
        new EmailService().sendSignedDocument({
          email: email!,
          firstName: firstName!,
          companyName: org.name,
          documentTitle: doc.title,
          signerName: doc.signerName ?? staff.fullName,
          idempotencyKey: `signed-copy/${doc.id}/${email!}`,
          ...copy,
        }),
        EMAIL_TIMEOUT_MS
      );
      const column = COPY_SENT_COLUMNS[side];
      doc[column] = new Date();
      await documentsRepo().update(doc.id, { [column]: doc[column] });
    })
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed) {
    throw (failed as PromiseRejectedResult).reason;
  }
};

const storeSignedFile = async (org: Organization, doc: StaffDocument): Promise<Buffer> => {
  if (doc.signedFileKey) {
    return readStoredFile(doc.signedFileKey);
  }
  const { pdf } = await buildDocumentPdf(org, doc);
  const key = spacesKeyFor("signed-documents", org.id, "signed.pdf");
  try {
    await withTimeout(
      uploadPrivateToSpaces(pdf, key, "application/pdf"),
      STORAGE_TIMEOUT_MS,
      "File storage did not respond"
    );
    const saved = await documentsRepo()
      .createQueryBuilder()
      .update(StaffDocument)
      .set({ signedFileKey: key, signedFileHash: sha256(pdf) })
      .where(`"id" = :id AND "signed_file_key" IS NULL`, { id: doc.id })
      .execute();
    if (saved.affected) {
      doc.signedFileKey = key;
      doc.signedFileHash = sha256(pdf);
      return pdf;
    }
  } catch (err) {
    await deleteSpacesObjectQuietly(key, `unsaved signed document ${doc.id}`);
    throw err;
  }
  await deleteSpacesObjectQuietly(key, `duplicate signed document ${doc.id}`);
  const current = await documentsRepo().findOneOrFail({ where: { id: doc.id } });
  doc.signedFileKey = current.signedFileKey;
  doc.signedFileHash = current.signedFileHash;
  return readStoredFile(current.signedFileKey!);
};

const CLAIM_FINALIZE_SQL = `
  UPDATE staff_documents SET finalize_locked_at = NOW()
  WHERE id = $1
    AND status = 'signed'
    AND check_code_version >= ${CHECK_CODE_VERSION}
    AND finalized_at IS NULL
    AND (finalize_locked_at IS NULL OR finalize_locked_at < NOW() - INTERVAL '${STALE_LOCK_INTERVAL}')
  RETURNING id`;

const DUE_FINALIZE_SQL = `
  SELECT id FROM staff_documents
  WHERE status = 'signed'
    AND check_code_version >= ${CHECK_CODE_VERSION}
    AND finalized_at IS NULL
    AND finalize_next_retry_at <= NOW()
    AND finalize_attempts < $1
    AND (finalize_locked_at IS NULL OR finalize_locked_at < NOW() - INTERVAL '${STALE_LOCK_INTERVAL}')
  ORDER BY finalize_next_retry_at
  LIMIT $2`;

/**
 * Runs after the signature is committed, so nothing here can undo it. Whoever holds the
 * claim stores the file once and sends the copies still owed; a failure is retried by
 * the sweep. Never throws. Returns the file when it has been stored.
 */
const finalizeDocument = async (
  documentId: string
): Promise<{ doc: StaffDocument; pdf: Buffer | null; finalized: boolean }> => {
  const claimed = await claimRowById(CLAIM_FINALIZE_SQL, documentId);
  const doc = await documentsRepo().findOneOrFail({ where: { id: documentId } });
  if (!claimed) {
    return { doc, pdf: null, finalized: !!doc.finalizedAt };
  }

  let pdf: Buffer | null = null;
  try {
    const org = await loadOrganization(doc.organizationId);
    const staff = await AppDataSource.getRepository(StaffMember).findOneOrFail({
      where: { id: doc.staffId },
    });
    pdf = await storeSignedFile(org, doc);
    await emailMissingCopies(org, doc, staff, { fileName: fileNameFor(doc), pdf });
    Object.assign(doc, {
      finalizedAt: new Date(),
      finalizeLockedAt: null,
      finalizeNextRetryAt: null,
      finalizeError: null,
    });
    await documentsRepo().update(doc.id, {
      finalizedAt: doc.finalizedAt,
      finalizeLockedAt: null,
      finalizeNextRetryAt: null,
      finalizeError: null,
    });
    return { doc, pdf, finalized: true };
  } catch (err) {
    logger.error(`Finishing signed document ${doc.id} failed: ${(err as Error).message}`);
    const failure = durableFailureUpdate(doc.finalizeAttempts, err);
    Object.assign(doc, {
      finalizeAttempts: failure.attempts,
      finalizeNextRetryAt: failure.nextRetryAt,
      finalizeLockedAt: null,
      finalizeError: failure.lastError,
    });
    await documentsRepo()
      .update(doc.id, {
        finalizeAttempts: failure.attempts,
        finalizeNextRetryAt: failure.nextRetryAt,
        finalizeLockedAt: null,
        finalizeError: failure.lastError,
      })
      .then(async () => {
        if (!failure.exhausted) return;
        await recordActivities(
          AppDataSource.manager,
          { id: doc.staffId, organizationId: doc.organizationId },
          [
            {
              type: StaffActivityType.DocumentCopyFailed,
              actorId: null,
              actorName: "AuxHR",
              meta: { title: doc.title },
            },
          ]
        );
      })
      .catch((recordErr: Error) =>
        logger.error(`Could not record the failure for ${doc.id}: ${recordErr.message}`)
      );
    return { doc, pdf, finalized: false };
  }
};

export const finishSigning = async (doc: StaffDocument): Promise<SignedCopy> => {
  const { pdf, finalized } = await finalizeDocument(doc.id);
  return {
    fileName: fileNameFor(doc),
    pdfBase64: pdf ? pdf.toString("base64") : null,
    copyPending: !finalized,
  };
};

export const reconcileDueDocumentFinalization = async (): Promise<{ attempted: number }> => {
  const ids = await selectDueIds(DUE_FINALIZE_SQL, [MAX_DURABLE_ATTEMPTS, SWEEP_BATCH_SIZE]);
  for (const id of ids) {
    await finalizeDocument(id);
  }
  return { attempted: ids.length };
};

export const retryFinalization = async (
  actor: User,
  organizationId: string,
  staffId: string,
  documentId: string
): Promise<DocumentView> => {
  await assertCanManagePeople(actor.id, organizationId);
  const staff = await findStaff(organizationId, staffId);
  const current = await findStaffDocument(AppDataSource.manager, staff, documentId);
  if (copyStatusOf(current) !== "failed") {
    return toDocumentView(current);
  }
  await documentsRepo().update(current.id, {
    finalizeAttempts: 0,
    finalizeNextRetryAt: new Date(Date.now() + FIRST_SWEEP_DELAY_MS),
    finalizeError: null,
  });
  const { doc } = await finalizeDocument(current.id);
  return toDocumentView(doc);
};

export const signWithToken = async (
  token: string,
  signerName: string,
  ip: string
): Promise<SignedCopy> => {
  const { doc } = await AppDataSource.transaction(async (em) =>
    signLockedDocument(em, await findByToken(token, em, true), signerName, ip)
  );
  return finishSigning(doc);
};

const SCAN_TYPES: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
};

const assertSigned = (doc: StaffDocument): void => {
  if (doc.status !== DocumentStatus.Signed) {
    throw new ConflictError("Only signed documents can be notarized");
  }
};

export const setNeedsNotarization = async (
  actor: User,
  organizationId: string,
  staffId: string,
  documentId: string,
  needsNotarization: boolean
): Promise<DocumentView> => {
  await assertCanManagePeople(actor.id, organizationId);
  return AppDataSource.transaction(async (em) => {
    const staff = await findStaff(organizationId, staffId, { em });
    const doc = await findStaffDocument(em, staff, documentId, true);
    assertSigned(doc);
    if (!needsNotarization && doc.notarizedScanKey) {
      throw new ConflictError("This document already has a notarized copy");
    }
    doc.needsNotarization = needsNotarization;
    return toDocumentView(await documentsRepo(em).save(doc));
  });
};

export const uploadNotarizedScan = async (
  actor: User,
  organizationId: string,
  staffId: string,
  documentId: string,
  file: Express.Multer.File | undefined
): Promise<DocumentView> => {
  await assertCanManagePeople(actor.id, organizationId);
  const extension = file ? SCAN_TYPES[file.mimetype] : undefined;
  if (!file || !extension) {
    throw new ValidationError("Upload the scan as a PDF, JPG or PNG file");
  }
  if (file.size === 0) {
    throw new ValidationError("File is empty");
  }
  const staff = await findStaff(organizationId, staffId);
  const current = await findStaffDocument(AppDataSource.manager, staff, documentId);
  assertSigned(current);
  if (!current.needsNotarization) {
    throw new ConflictError("Mark the document as needing notarization first");
  }

  const key = spacesKeyFor("notarized-scans", organizationId, `scan${extension}`);
  await uploadPrivateToSpaces(file.buffer, key, file.mimetype);
  let replacedKey: string | null = null;
  try {
    const saved = await AppDataSource.transaction(async (em) => {
      const doc = await findStaffDocument(em, staff, documentId, true);
      replacedKey = doc.notarizedScanKey;
      Object.assign(doc, {
        notarizedScanKey: key,
        notarizedScanType: file.mimetype,
        notarizedAt: new Date(),
      });
      const result = await documentsRepo(em).save(doc);
      await recordActivities(em, staff, [
        activityEntry(StaffActivityType.DocumentNotarized, actor, { title: doc.title }),
      ]);
      return result;
    });
    await deleteSpacesObjectQuietly(replacedKey, `notarized scan ${documentId}`);
    return toDocumentView(saved);
  } catch (err) {
    await deleteSpacesObjectQuietly(key, `unsaved notarized scan ${documentId}`);
    throw err;
  }
};

export const downloadNotarizedScan = async (
  actor: User,
  organizationId: string,
  staffId: string,
  documentId: string,
  ip: string
): Promise<{ fileName: string; contentType: string; file: Buffer }> => {
  const staff = await openStaff(actor, organizationId, staffId, StaffAccessResource.Contract, ip);
  const doc = await findStaffDocument(AppDataSource.manager, staff, documentId);
  if (!doc.notarizedScanKey || !doc.notarizedScanType) {
    throw new NotFoundError("This document has no notarized copy");
  }
  return {
    fileName: fileNameFor(doc).replace(/\.pdf$/, `-notarized${SCAN_TYPES[doc.notarizedScanType]}`),
    contentType: doc.notarizedScanType,
    file: await getFromSpaces(doc.notarizedScanKey),
  };
};
