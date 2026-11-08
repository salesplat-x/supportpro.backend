import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { ApplicationCheck } from "../entities/ApplicationCheck.js";
import { Job } from "../entities/Job.js";
import { Organization } from "../entities/Organization.js";
import { AuthorizationError, ConflictError, NotFoundError } from "../utils/errors";
import type { CheckType } from "../types/checks.js";
import { findConsent } from "./checkConsent.js";
import { overallStatus } from "./checkStatus.js";
import { isPostingCompanyMember } from "./jobPostingAccess.js";

const repo = () => AppDataSource.getRepository(ApplicationCheck);

const findApplication = async (applicationId: string): Promise<Application> => {
  const application = await AppDataSource.getRepository(Application).findOne({
    where: { id: applicationId },
  });
  if (!application) throw new NotFoundError("Application not found");
  return application;
};

const toCheck = (row: ApplicationCheck) => ({
  id: row.id,
  applicationId: row.applicationId,
  type: row.type,
  status: row.status,
  resultText: row.resultText,
  orderedById: row.orderedById,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const isCompanyOwner = async (userId: string, jobId: string): Promise<boolean> => {
  const job = await AppDataSource.getRepository(Job).findOne({
    where: { id: jobId },
    select: { id: true, organizationId: true, postedById: true },
  });
  if (!job) return false;
  if (job.organizationId) {
    const organization = await AppDataSource.getRepository(Organization).findOne({
      where: { id: job.organizationId },
      select: { id: true, ownerId: true },
    });
    return organization?.ownerId === userId;
  }
  return job.postedById === userId;
};

export const orderCheck = async (userId: string, applicationId: string, type: CheckType) => {
  const application = await findApplication(applicationId);
  if (!(await isPostingCompanyMember(userId, application.jobId))) {
    throw new AuthorizationError("Only the company that posted this job can order checks");
  }
  if (!(await findConsent(applicationId))) {
    throw new ConflictError("The candidate has not agreed to background checks yet");
  }
  const saved = await repo().save(
    repo().create({ applicationId, orderedById: userId, type, status: "pending", resultText: null })
  );
  return toCheck(saved);
};

export const listChecksForCompany = async (userId: string, applicationId: string) => {
  const application = await findApplication(applicationId);
  const rows = await repo().find({ where: { applicationId }, order: { createdAt: "ASC" } });
  const orderedByCaller = rows.some((row) => row.orderedById === userId);
  if (!orderedByCaller && !(await isCompanyOwner(userId, application.jobId))) {
    throw new AuthorizationError(
      "Only the company owner or the recruiter who ordered can read checks"
    );
  }
  return {
    applicationId,
    overallStatus: overallStatus(rows),
    checks: rows.map(toCheck),
  };
};
