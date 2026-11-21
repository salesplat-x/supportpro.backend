import crypto from "crypto";
import { EntityManager } from "typeorm";
import env from "../config/env.js";
import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import { StaffAccessResource } from "../entities/StaffAccessLog.js";
import { StaffActivityType } from "../entities/StaffActivity.js";
import {
  type DocumentFields,
  DocumentStatus,
  DocumentTemplate,
  StaffDocument,
} from "../entities/StaffDocument.js";
import { StaffMember, StaffStatus } from "../entities/StaffMember.js";
import { PayPeriod } from "../entities/PayPackage.js";
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
import { assertNotEnded, loadPay, longDate, money } from "./pay.js";
import { assertOwner } from "./peopleAccess.js";
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
export type DocumentDisplayStatus = DocumentStatus | "to_notarize" | "notarized";

export interface DocumentView {
  id: string;
  template: DocumentTemplate;
  title: string;
  status: DocumentStatus;
  /** What the row shows: the stored status, or To notarize and Notarized once a signed document needs a notary. */
  displayStatus: DocumentDisplayStatus;
  fields: DocumentFields | null;
  createdAt: Date;
  sentAt: Date | null;
  openedAt: Date | null;
  signedAt: Date | null;
  declinedAt: Date | null;
  signerName: string | null;
  sentByName: string | null;
  linkExpiresAt: Date | null;
  needsNotarization: boolean;
  notarizedAt: Date | null;
  notarizedScanName: string | null;
  notarizedByName: string | null;
  checkCode: string | null;
  copyStatus: DocumentCopyStatus;
}

export interface SigningView {
  companyName: string;
  companyLogoUrl: string | null;
  companyEmail: string | null;
  employeeName: string;
  title: string;
  dateLabel: string;
  body: string;
  signatory: string | null;
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

const displayStatusOf = (doc: StaffDocument): DocumentDisplayStatus => {
  if (doc.status === DocumentStatus.Signed && doc.needsNotarization) {
    return doc.notarizedScanKey ? "notarized" : "to_notarize";
  }
  return doc.status;
};

export const toDocumentView = (doc: StaffDocument): DocumentView => ({
  id: doc.id,
  template: doc.template,
  title: doc.title,
  status: doc.status,
  displayStatus: displayStatusOf(doc),
  fields: doc.fields,
  createdAt: doc.createdAt,
  sentAt: doc.sentAt,
  openedAt: doc.openedAt,
  signedAt: doc.signedAt,
  declinedAt: doc.declinedAt,
  signerName: doc.signerName,
  sentByName: doc.sentBy ? `${doc.sentBy.firstName} ${doc.sentBy.lastName}`.trim() : null,
  linkExpiresAt: doc.tokenExpiresAt,
  needsNotarization: doc.needsNotarization,
  notarizedAt: doc.notarizedAt,
  notarizedScanName: doc.notarizedScanName,
  notarizedByName: doc.notarizedByName,
  checkCode: doc.checkCode,
  copyStatus: copyStatusOf(doc),
});

const loadOrganization = (organizationId: string): Promise<Organization> =>
  AppDataSource.getRepository(Organization).findOneOrFail({ where: { id: organizationId } });

const documentsRepo = (em: EntityManager = AppDataSource.manager) =>
  em.getRepository(StaffDocument);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const cleanFields = (input: DocumentFields | null | undefined): DocumentFields => {
  const fields: DocumentFields = {};
  if (input?.startDate) {
    if (!DATE_ONLY.test(input.startDate) || Number.isNaN(Date.parse(input.startDate))) {
      throw new ValidationError("startDate must be a date like 2026-11-05");
    }
    fields.startDate = input.startDate;
  }
  if (input?.jobTitle?.trim()) fields.jobTitle = input.jobTitle.trim().slice(0, 120);
  if (input?.managerName?.trim()) fields.managerName = input.managerName.trim().slice(0, 120);
  return fields;
};

const managerNameOf = async (staff: StaffMember): Promise<string | null> => {
  if (!staff.managerId) return null;
  const manager = await AppDataSource.getRepository(StaffMember).findOne({
    where: { id: staff.managerId },
    select: { id: true, fullName: true },
  });
  return manager?.fullName ?? null;
};

export interface DocumentPreview {
  title: string;
  body: string;
  missing: string[];
  facts: {
    startDate: string;
    jobTitle: string;
    managerName: string | null;
    monthlyPay: string | null;
  };
}

const renderFor = async (
  org: Organization,
  staff: StaffMember,
  template: DocumentTemplate,
  fields: DocumentFields | null = null
): Promise<DocumentPreview> => {
  const pay = await loadPay(staff.id);
  const current = pay.packages.find((pkg) => pkg.id === pay.currentPackageId);
  const startDate = fields?.startDate ?? staff.startDate;
  const jobTitle = fields?.jobTitle ?? staff.jobTitle;
  const managerName = fields?.managerName ?? (await managerNameOf(staff));
  const rendered = renderContract(template, {
    companyName: org.name,
    fullName: staff.fullName,
    jobTitle,
    startDate: longDate(startDate),
    managerName,
    payParagraph: current?.paragraph ?? null,
  });
  return {
    ...rendered,
    facts: {
      startDate,
      jobTitle,
      managerName,
      monthlyPay: current
        ? money(
            current.currency,
            current.period === PayPeriod.Monthly ? current.baseSalary : current.baseSalary / 12
          )
        : null,
    },
  };
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

const fullNameOfUser = (user: Pick<User, "firstName" | "lastName"> | null): string | null =>
  user ? `${user.firstName} ${user.lastName}`.trim() : null;

/** The person who sent the document, with their staff job title when they have one. */
const signatoryOf = async (doc: StaffDocument): Promise<string | null> => {
  if (!doc.sentById) return null;
  const sender = await AppDataSource.getRepository(User).findOne({
    where: { id: doc.sentById },
    select: { id: true, firstName: true, lastName: true },
  });
  const name = fullNameOfUser(sender);
  if (!name) return null;
  const staff = await AppDataSource.getRepository(StaffMember).findOne({
    where: { organizationId: doc.organizationId, userId: doc.sentById },
    select: { id: true, jobTitle: true },
  });
  return staff ? `${name}, ${staff.jobTitle}` : name;
};

export const documentDateLabel = (doc: StaffDocument): string =>
  (doc.sentAt ?? doc.createdAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Africa/Lagos",
  });

export const buildDocumentPdf = async (
  org: Organization,
  doc: StaffDocument
): Promise<{ fileName: string; pdf: Buffer }> => {
  const staff = await AppDataSource.getRepository(StaffMember).findOneOrFail({
    where: { id: doc.staffId },
    select: { id: true, fullName: true, email: true },
  });
  const sender = doc.sentById
    ? await AppDataSource.getRepository(User).findOne({
        where: { id: doc.sentById },
        select: { id: true, firstName: true, lastName: true },
      })
    : null;
  const pdf = await generateContractPdf({
    companyName: org.name,
    logo: await loadLogo(org),
    title: doc.title,
    dateLabel: documentDateLabel(doc),
    body: doc.bodyText,
    signatory: await signatoryOf(doc),
    employeeName: staff.fullName,
    signature:
      doc.status === DocumentStatus.Signed && doc.signedAt
        ? {
            name: doc.signerName ?? "",
            email: staff.email,
            signedAt: doc.signedAt,
            sentBy: fullNameOfUser(sender),
            sentAt: doc.sentAt,
            openedAt: doc.openedAt,
            checkCode: doc.checkCode ?? "",
            check:
              doc.checkCodeVersion >= CHECK_CODE_VERSION
                ? { documentId: doc.id, verifyUrl: `${env.website}/verify` }
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
        jobTitle: doc.fields?.jobTitle ?? staff.jobTitle,
        startDate: longDate(doc.fields?.startDate ?? staff.startDate),
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
    relations: { sentBy: true },
    order: { createdAt: "DESC" },
  });
  return docs.map(toDocumentView);
};

export const getDocument = async (
  actor: User,
  organizationId: string,
  staffId: string,
  documentId: string,
  ip: string
): Promise<{ document: DocumentView; preview: DocumentPreview }> => {
  const staff = await openStaff(actor, organizationId, staffId, StaffAccessResource.Contract, ip);
  const doc = await documentsRepo().findOne({
    where: { id: documentId, staffId, organizationId },
    relations: { sentBy: true },
  });
  if (!doc) throw new NotFoundError("Document not found");
  const preview =
    doc.status === DocumentStatus.Draft
      ? await renderFor(await loadOrganization(organizationId), staff, doc.template, doc.fields)
      : {
          title: doc.title,
          body: doc.bodyText,
          missing: [],
          facts: {
            startDate: doc.fields?.startDate ?? staff.startDate,
            jobTitle: doc.fields?.jobTitle ?? staff.jobTitle,
            managerName: doc.fields?.managerName ?? null,
            monthlyPay: null,
          },
        };
  return { document: toDocumentView(doc), preview };
};

/** One draft per person and template: saving again replaces it, so "Back to edit" never piles them up. */
export const saveDraft = async (
  actor: User,
  organizationId: string,
  staffId: string,
  template: DocumentTemplate,
  rawFields: DocumentFields | null
): Promise<{ document: DocumentView; preview: DocumentPreview }> => {
  const org = await assertOwner(actor.id, organizationId);
  const fields = cleanFields(rawFields);
  const { saved, preview } = await AppDataSource.transaction(async (em) => {
    const staff = await findStaff(organizationId, staffId, { em, lock: true });
    assertNotEnded(staff);
    const rendered = await renderFor(org, staff, template, fields);
    const existing = await documentsRepo(em).findOne({
      where: { staffId, organizationId, template, status: DocumentStatus.Draft },
    });
    const doc =
      existing ??
      documentsRepo(em).create({
        organizationId,
        staffId,
        template,
        status: DocumentStatus.Draft,
        sentAt: null,
      });
    Object.assign(doc, {
      title: rendered.title,
      bodyText: rendered.body,
      fields: Object.keys(fields).length ? fields : null,
      sentById: actor.id,
    });
    return { saved: await documentsRepo(em).save(doc), preview: rendered };
  });
  const withSender = await documentsRepo().findOneOrFail({
    where: { id: saved.id },
    relations: { sentBy: true },
  });
  return { document: toDocumentView(withSender), preview };
};

export const deleteDraft = async (
  actor: User,
  organizationId: string,
  staffId: string,
  documentId: string
): Promise<void> => {
  await assertOwner(actor.id, organizationId);
  const staff = await findStaff(organizationId, staffId);
  const doc = await findStaffDocument(AppDataSource.manager, staff, documentId);
  if (doc.status !== DocumentStatus.Draft) {
    throw new ConflictError("Only a draft can be deleted");
  }
  await documentsRepo().delete(doc.id);
};

export const sendDocument = async (
  actor: User,
  organizationId: string,
  staffId: string,
  documentId: string
): Promise<{ document: DocumentView; emailSent: boolean }> => {
  const org = await assertOwner(actor.id, organizationId);
  let token = "";
  let sent: { doc: StaffDocument; staff: StaffMember };
  try {
    sent = await AppDataSource.transaction(async (em) => {
      const staff = await findStaff(organizationId, staffId, { em, lock: true });
      assertNotEnded(staff);
      const doc = await findStaffDocument(em, staff, documentId, true);
      if (doc.status !== DocumentStatus.Draft) {
        throw new ConflictError("Only a draft can be sent for signing");
      }
      const rendered = await renderFor(org, staff, doc.template, doc.fields);
      if (rendered.missing.length > 0) {
        throw new ValidationError("Set up pay first. This document includes the pay paragraph.");
      }
      Object.assign(doc, {
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
  const org = await assertOwner(actor.id, organizationId);
  let token = "";
  const sent = await AppDataSource.transaction(async (em) => {
    const staff = await findStaff(organizationId, staffId, { em, lock: true });
    assertNotEnded(staff);
    const doc = await findStaffDocument(em, staff, documentId, true);
    if (doc.status !== DocumentStatus.Sent && doc.status !== DocumentStatus.Declined) {
      throw new ConflictError(
        doc.status === DocumentStatus.Signed
          ? "This document is already signed"
          : "Send the draft for signing first"
      );
    }
    token = issueSigningToken(doc);
    doc.status = DocumentStatus.Sent;
    doc.declinedAt = null;
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

const linkGone = async (organizationId: string, title: string, em: EntityManager) => {
  const org = await em.getRepository(Organization).findOne({
    where: { id: organizationId },
    select: { id: true, name: true, email: true },
  });
  return new AppError(410, "LINK_EXPIRED", LINK_GONE, true, {
    documentTitle: title,
    companyName: org?.name ?? null,
    companyEmail: org?.email ?? null,
  });
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
    throw await linkGone(doc.organizationId, doc.title, em);
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
    companyEmail: org.email,
    employeeName: staff.fullName,
    title: doc.title,
    dateLabel: documentDateLabel(doc),
    body: doc.bodyText,
    signatory: await signatoryOf(doc),
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

/** Shared by the email link and My work. The caller has locked `doc` in `em`. */
export const declineLockedDocument = async (
  em: EntityManager,
  doc: StaffDocument,
  ip: string
): Promise<void> => {
  const staff = await staffOf(doc, em);
  Object.assign(doc, {
    status: DocumentStatus.Declined,
    declinedAt: new Date(),
    tokenHash: null,
    tokenExpiresAt: null,
  });
  await documentsRepo(em).save(doc);
  await recordActivities(em, staff, [
    {
      type: StaffActivityType.DocumentDeclined,
      actorId: staff.userId,
      actorName: staff.fullName,
      meta: { title: doc.title, ip },
    },
  ]);
};

export const declineWithToken = async (token: string, ip: string): Promise<void> => {
  await AppDataSource.transaction(async (em) =>
    declineLockedDocument(em, await findByToken(token, em, true), ip)
  );
};

/** Contracts stay between the company's creator and the employee, whoever sent this one. */
const companyCopyRecipient = (org: Organization) =>
  org.ownerId
    ? AppDataSource.getRepository(User).findOne({
        where: { id: org.ownerId },
        select: { id: true, email: true, firstName: true },
      })
    : null;

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
  const company = doc.companyCopySentAt ? null : await companyCopyRecipient(org);
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
  await assertOwner(actor.id, organizationId);
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
  await assertOwner(actor.id, organizationId);
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
  await assertOwner(actor.id, organizationId);
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
        notarizedScanName: file.originalname.replace(/[^\w .-]/g, "_").slice(0, 200) || null,
        notarizedByName: `${actor.firstName} ${actor.lastName}`.trim().slice(0, 120),
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
