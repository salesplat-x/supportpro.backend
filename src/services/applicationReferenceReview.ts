import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { ApplicationReference } from "../entities/ApplicationReference.js";
import { Job } from "../entities/Job.js";
import { AuthorizationError, ConflictError, NotFoundError } from "../utils/errors";
import { REFERENCE_QUESTIONS } from "./applicationReferenceAnswers.js";
import { newToken, sendReferenceEmail, toReferee } from "./applicationReferences.js";
import { getActiveOrganizationId } from "./organizationScope.js";

const repo = () => AppDataSource.getRepository(ApplicationReference);

const isPostingCompanyMember = async (userId: string, jobId: string): Promise<boolean> => {
  const job = await AppDataSource.getRepository(Job).findOne({
    where: { id: jobId },
    select: { id: true, organizationId: true, postedById: true },
  });
  if (!job) return false;
  if (job.organizationId) {
    return (await getActiveOrganizationId(userId)) === job.organizationId;
  }
  return job.postedById === userId;
};

const answerList = (row: ApplicationReference) => {
  if (!row.answers) return null;
  return REFERENCE_QUESTIONS.filter(({ key }) => row.answers![key]).map(({ key, question }) => ({
    key,
    question,
    answer: row.answers![key]!,
  }));
};

export const getReferencesForCompany = async (userId: string, applicationId: string) => {
  const application = await AppDataSource.getRepository(Application).findOne({
    where: { id: applicationId },
  });
  if (!application) throw new NotFoundError("Application not found");
  if (!(await isPostingCompanyMember(userId, application.jobId))) {
    throw new AuthorizationError("Only the company that posted this job can read its references");
  }
  const rows = await repo().find({ where: { applicationId }, order: { createdAt: "ASC" } });
  return {
    applicationId,
    references: rows.map((row) => ({ ...toReferee(row), answers: answerList(row) })),
  };
};

export const resendReference = async (userId: string, referenceId: string) => {
  const row = await repo().findOne({ where: { id: referenceId } });
  if (!row) throw new NotFoundError("Reference not found");
  if (!(await isPostingCompanyMember(userId, row.jobId))) {
    throw new AuthorizationError("Only the company that posted this job can resend a request");
  }
  if (row.answeredAt) throw new ConflictError("This referee has already answered");
  const { token, tokenHash, expiresAt } = newToken();
  await repo().update(row.id, { tokenHash, tokenExpiresAt: expiresAt, sentAt: null });
  await sendReferenceEmail({ ...row, tokenHash, tokenExpiresAt: expiresAt, sentAt: null }, token);
  return toReferee(await repo().findOneByOrFail({ id: row.id }));
};
