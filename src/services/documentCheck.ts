import crypto from "crypto";
import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import { StaffAccessResource } from "../entities/StaffAccessLog.js";
import { DocumentStatus, StaffDocument } from "../entities/StaffDocument.js";
import { StaffMember } from "../entities/StaffMember.js";
import { NotFoundError, ValidationError } from "../utils/errors";
import { CHECK_CODE_VERSION, checkCodeOf } from "./contracts.js";
import { logStaffAccess } from "./staffAudit.js";

export type DocumentCheckResult = "verified" | "changed" | "limited";

export interface DocumentCheckView {
  result: DocumentCheckResult;
  companyName: string;
  title: string;
  signerName: string | null;
  signedAt: Date | null;
}

const NO_MATCH = "We couldn't match this to a signed document";
const FINGERPRINT_LENGTH = 64;

const sameFingerprint = (a: string, b: string): boolean =>
  a.length === FINGERPRINT_LENGTH &&
  b.length === FINGERPRINT_LENGTH &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Older documents predate the stored stamp, so their code can only be compared, not recomputed. */
const resultOf = (doc: StaffDocument): DocumentCheckResult => {
  if (doc.checkCodeVersion < CHECK_CODE_VERSION) return "limited";
  return sameFingerprint(checkCodeOf(doc), doc.checkCode ?? "") ? "verified" : "changed";
};

const summaryOf = async (doc: StaffDocument, ip: string): Promise<DocumentCheckView> => {
  const [org, staff] = await Promise.all([
    AppDataSource.getRepository(Organization).findOneOrFail({
      where: { id: doc.organizationId },
      select: { id: true, name: true },
    }),
    AppDataSource.getRepository(StaffMember).findOneOrFail({
      where: { id: doc.staffId },
      select: { id: true, fullName: true },
    }),
  ]);
  await logStaffAccess({
    organizationId: doc.organizationId,
    actor: { id: null, name: "Document check page" },
    staff,
    resource: StaffAccessResource.Contract,
    ip,
  });
  return {
    result: resultOf(doc),
    companyName: org.name,
    title: doc.title,
    signerName: doc.signerName,
    signedAt: doc.signedAt,
  };
};

export const checkDocumentCode = async (
  documentId: string,
  checkCode: string,
  ip: string
): Promise<DocumentCheckView> => {
  const doc = await AppDataSource.getRepository(StaffDocument).findOne({
    where: { id: documentId, status: DocumentStatus.Signed },
  });
  if (!doc || !sameFingerprint(checkCode.toLowerCase(), doc.checkCode ?? "")) {
    throw new NotFoundError(NO_MATCH);
  }
  return summaryOf(doc, ip);
};

export const checkDocumentFile = async (
  file: Express.Multer.File | undefined,
  ip: string
): Promise<DocumentCheckView> => {
  if (!file || file.mimetype !== "application/pdf" || file.size === 0) {
    throw new ValidationError("Upload the signed document as a PDF file");
  }
  const hash = crypto.createHash("sha256").update(file.buffer).digest("hex");
  const doc = await AppDataSource.getRepository(StaffDocument).findOne({
    where: { signedFileHash: hash, status: DocumentStatus.Signed },
  });
  if (!doc) {
    throw new NotFoundError(NO_MATCH);
  }
  return summaryOf(doc, ip);
};
