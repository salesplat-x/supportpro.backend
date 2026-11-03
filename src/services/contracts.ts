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
import { assertCanManagePeople } from "./peopleAccess.js";
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
const LINK_GONE = "This link has expired or was already used";

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
  pdfBase64: string;
}

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

export const downloadDocument = async (
  actor: User,
  organizationId: string,
  staffId: string,
  documentId: string,
  ip: string
): Promise<{ fileName: string; pdf: Buffer }> => {
  const staff = await openStaff(actor, organizationId, staffId, StaffAccessResource.Contract, ip);
  const doc = await findStaffDocument(AppDataSource.manager, staff, documentId);
  return buildDocumentPdf(await loadOrganization(organizationId), doc);
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

const checkCodeOf = (doc: StaffDocument, signerName: string, signedAt: Date): string =>
  crypto
    .createHash("sha256")
    .update([doc.id, doc.bodyText, signerName, signedAt.toISOString()].join("\n"))
    .digest("hex");

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
    checkCode: checkCodeOf(doc, signerName, signedAt),
    tokenHash: null,
    tokenExpiresAt: null,
  });
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

const emailSignedCopies = async (
  org: Organization,
  doc: StaffDocument,
  staff: StaffMember,
  copy: { fileName: string; pdf: Buffer }
): Promise<void> => {
  const sender = doc.sentById
    ? await AppDataSource.getRepository(User).findOne({
        where: { id: doc.sentById },
        select: { id: true, email: true, firstName: true },
      })
    : null;
  const recipients = [
    { email: staff.email, firstName: staff.fullName.split(" ")[0] ?? staff.fullName },
    ...(sender ? [{ email: sender.email, firstName: sender.firstName }] : []),
  ];
  await Promise.all(
    recipients.map((recipient) =>
      withTimeout(
        new EmailService().sendSignedDocument({
          ...recipient,
          companyName: org.name,
          documentTitle: doc.title,
          signerName: doc.signerName ?? staff.fullName,
          ...copy,
        }),
        EMAIL_TIMEOUT_MS
      ).catch((err: Error) =>
        logger.error(`Signed copy email failed for document ${doc.id}: ${err.message}`)
      )
    )
  );
};

/** Runs after the signature is committed, so a failed email never undoes it. */
export const finishSigning = async (
  doc: StaffDocument,
  staff: StaffMember
): Promise<SignedCopy> => {
  const org = await loadOrganization(doc.organizationId);
  const copy = await buildDocumentPdf(org, doc);
  await emailSignedCopies(org, doc, staff, copy);
  return { fileName: copy.fileName, pdfBase64: copy.pdf.toString("base64") };
};

export const signWithToken = async (
  token: string,
  signerName: string,
  ip: string
): Promise<SignedCopy> => {
  const { doc, staff } = await AppDataSource.transaction(async (em) =>
    signLockedDocument(em, await findByToken(token, em, true), signerName, ip)
  );
  return finishSigning(doc, staff);
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
