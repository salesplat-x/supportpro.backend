import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { ApplicationReference } from "../entities/ApplicationReference.js";
import { Job } from "../entities/Job.js";
import { AppError, AuthorizationError, ConflictError, NotFoundError } from "../utils/errors";
import { newToken, questionsOf, sendReferenceEmail, toReferee } from "./applicationReferences.js";
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
  const answers = row.answers;
  if (!answers) return null;
  return (questionsOf(row) ?? [])
    .filter(({ key }) => answers[key])
    .map(({ key, question }) => ({ key, question, answer: answers[key]! }));
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
  if (!row.sentAt) {
    throw new ConflictError("Send your reference questions from the company page first");
  }
  const { token, tokenHash, expiresAt } = newToken();
  const questions = questionsOf(row);
  await repo().update(row.id, { tokenHash, tokenExpiresAt: expiresAt, questions });
  if (
    !(await sendReferenceEmail({ ...row, tokenHash, tokenExpiresAt: expiresAt, questions }, token))
  ) {
    throw new AppError(
      502,
      "REFERENCE_EMAIL_FAILED",
      "We couldn't email this referee. Try again in a moment",
      true
    );
  }
  return toReferee(await repo().findOneByOrFail({ id: row.id }));
};
