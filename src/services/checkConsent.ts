import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { ApplicationConsent } from "../entities/ApplicationConsent.js";
import { AuthorizationError, NotFoundError, ValidationError } from "../utils/errors";
import { isPostingCompanyMember } from "./jobPostingAccess.js";

export const CHECKS_CONSENT_VERSION = "2026-11-v1";

const repo = () => AppDataSource.getRepository(ApplicationConsent);

const findApplication = async (applicationId: string): Promise<Application> => {
  const application = await AppDataSource.getRepository(Application).findOne({
    where: { id: applicationId },
  });
  if (!application) throw new NotFoundError("Application not found");
  return application;
};

const toConsent = (row: ApplicationConsent) => ({
  applicationId: row.applicationId,
  version: row.version,
  agreedAt: row.agreedAt,
});

export const agreeToChecks = async (userId: string, applicationId: string, version: string) => {
  const application = await findApplication(applicationId);
  if (application.talentId !== userId) {
    throw new AuthorizationError("Only the candidate who applied can agree to background checks");
  }
  if (version !== CHECKS_CONSENT_VERSION) {
    throw new ValidationError(`Consent text version must be ${CHECKS_CONSENT_VERSION}`);
  }
  const existing = await repo().findOne({ where: { applicationId } });
  if (existing) return { created: false, consent: toConsent(existing) };
  const saved = await repo().save(
    repo().create({ applicationId, talentId: userId, version, agreedAt: new Date() })
  );
  return { created: true, consent: toConsent(saved) };
};

export const readConsentForCompany = async (userId: string, applicationId: string) => {
  const application = await findApplication(applicationId);
  if (!(await isPostingCompanyMember(userId, application.jobId))) {
    throw new AuthorizationError("Only the company that posted this job can read its consent");
  }
  const row = await repo().findOne({ where: { applicationId } });
  return {
    applicationId,
    consented: Boolean(row),
    version: row?.version ?? null,
    agreedAt: row?.agreedAt ?? null,
  };
};
