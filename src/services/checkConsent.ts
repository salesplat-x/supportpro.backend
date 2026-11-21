import env from "../config/env.js";
import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { ApplicationConsent } from "../entities/ApplicationConsent.js";
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from "../utils/errors";
import EmailService from "../utils/integrations/email/emailService.js";
import logger from "../utils/logger.js";
import { encryptSecret } from "../utils/secretBox.js";
import { isPostingCompanyMember } from "./jobPostingAccess.js";

export const CHECKS_CONSENT_VERSION = "2026-11-v2";
export const ID_KINDS = ["nin", "bvn"] as const;
export type IdKind = (typeof ID_KINDS)[number];
export type ConsentState = "not_requested" | "requested" | "agreed" | "declined";

const ID_NUMBER = /^\d{11}$/;

const repo = () => AppDataSource.getRepository(ApplicationConsent);

const findApplication = async (applicationId: string): Promise<Application> => {
  const application = await AppDataSource.getRepository(Application).findOne({
    where: { id: applicationId },
  });
  if (!application) throw new NotFoundError("Application not found");
  return application;
};

export const consentState = (row: ApplicationConsent | null): ConsentState => {
  if (!row) return "not_requested";
  if (row.agreedAt) return "agreed";
  if (row.declinedAt) return "declined";
  return "requested";
};

const toConsent = (applicationId: string, row: ApplicationConsent | null) => ({
  applicationId,
  state: consentState(row),
  version: row?.version ?? null,
  requestedAt: row?.requestedAt ?? null,
  agreedAt: row?.agreedAt ?? null,
  declinedAt: row?.declinedAt ?? null,
  idKind: row?.idKind ?? null,
  idNumberLast4: row?.idNumberLast4 ?? null,
});

export const findConsent = async (applicationId: string): Promise<ApplicationConsent | null> =>
  repo().findOne({ where: { applicationId } });

const insertRequest = async (application: Application): Promise<ApplicationConsent | null> => {
  const inserted = await repo()
    .createQueryBuilder()
    .insert()
    .values({
      applicationId: application.id,
      talentId: application.talentId,
      requestedAt: new Date(),
    })
    .orIgnore()
    .returning("*")
    .execute();
  const raw = inserted.raw as Array<{ id: string }>;
  return raw.length ? repo().findOneByOrFail({ id: raw[0]!.id }) : null;
};

const sendRequestEmail = async (applicationId: string): Promise<void> => {
  const application = await AppDataSource.getRepository(Application).findOne({
    where: { id: applicationId },
    relations: { job: { role: true, organization: true }, talent: true },
  });
  if (!application) return;
  const company = application.job.organization?.name ?? "The company";
  const jobTitle = application.job.role?.name ?? "your application";
  await new EmailService().sendChecksConsentRequest({
    to: application.talent.email,
    firstName: application.talent.firstName,
    companyName: company,
    jobTitle,
    ctaUrl: `${env.website || "https://auxhr.com"}/talentDashboard/applications/${application.id}/checks`,
  });
};

export const requestConsent = async (application: Application): Promise<boolean> => {
  const created = await insertRequest(application);
  if (!created) return false;
  try {
    await sendRequestEmail(application.id);
  } catch (error) {
    logger.warn(`Checks consent email for application ${application.id} failed: ${String(error)}`);
  }
  return true;
};

export const requestConsentOnShortlist = async (application: Application): Promise<void> => {
  try {
    await requestConsent(application);
  } catch (error) {
    logger.error(
      `Checks consent request failed for application ${application.id}: ${(error as Error).message}`
    );
  }
};

export const requestConsentForCompany = async (userId: string, applicationId: string) => {
  const application = await findApplication(applicationId);
  if (!(await isPostingCompanyMember(userId, application.jobId))) {
    throw new AuthorizationError("Only the company that posted this job can ask for consent");
  }
  const created = await requestConsent(application);
  return { created, consent: toConsent(applicationId, await findConsent(applicationId)) };
};

const ownApplication = async (userId: string, applicationId: string): Promise<Application> => {
  const application = await findApplication(applicationId);
  if (application.talentId !== userId) {
    throw new AuthorizationError("Only the candidate who applied can answer background checks");
  }
  return application;
};

export const agreeToChecks = async (
  userId: string,
  applicationId: string,
  input: { version: string; idKind: IdKind; idNumber: string }
) => {
  const application = await ownApplication(userId, applicationId);
  if (input.version !== CHECKS_CONSENT_VERSION) {
    throw new ValidationError(`Consent text version must be ${CHECKS_CONSENT_VERSION}`);
  }
  if (!ID_NUMBER.test(input.idNumber)) {
    throw new ValidationError("The NIN or BVN must be exactly 11 digits");
  }
  const existing = await findConsent(applicationId);
  if (existing?.agreedAt) return { created: false, consent: toConsent(applicationId, existing) };

  const now = new Date();
  const row =
    existing ?? repo().create({ applicationId, talentId: application.talentId, requestedAt: now });
  row.version = input.version;
  row.agreedAt = now;
  row.declinedAt = null;
  row.idKind = input.idKind;
  row.idNumberEncrypted = encryptSecret(input.idNumber);
  row.idNumberLast4 = input.idNumber.slice(-4);
  const saved = await repo().save(row);
  return { created: true, consent: toConsent(applicationId, saved) };
};

export const declineChecks = async (userId: string, applicationId: string) => {
  const application = await ownApplication(userId, applicationId);
  const existing = await findConsent(applicationId);
  if (existing?.agreedAt) throw new ConflictError("You already agreed to these checks");
  const row =
    existing ??
    repo().create({ applicationId, talentId: application.talentId, requestedAt: new Date() });
  row.declinedAt = row.declinedAt ?? new Date();
  const saved = await repo().save(row);
  return toConsent(applicationId, saved);
};

export const readConsentForCandidate = async (userId: string, applicationId: string) => {
  await ownApplication(userId, applicationId);
  return toConsent(applicationId, await findConsent(applicationId));
};

export const readConsentForCompany = async (userId: string, applicationId: string) => {
  const application = await findApplication(applicationId);
  if (!(await isPostingCompanyMember(userId, application.jobId))) {
    throw new AuthorizationError("Only the company that posted this job can read its consent");
  }
  return toConsent(applicationId, await findConsent(applicationId));
};
