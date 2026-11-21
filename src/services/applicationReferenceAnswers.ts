import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { ApplicationReference } from "../entities/ApplicationReference.js";
import { AppError, NotFoundError, ValidationError } from "../utils/errors";
import type { ReferenceQuestion } from "../types/referenceQuestion.js";
import { hashToken, questionsOf } from "./applicationReferences.js";

export const REFERENCE_ANSWER_MAX_LENGTH = 2000;

const repo = () => AppDataSource.getRepository(ApplicationReference);

const gone = (details?: Record<string, unknown>) =>
  new AppError(
    410,
    "REFERENCE_LINK_GONE",
    "This reference link has expired or was already used",
    true,
    details
  );

const goneWithContext = async (row: ApplicationReference): Promise<AppError> => {
  const application = await AppDataSource.getRepository(Application).findOne({
    where: { id: row.applicationId },
    relations: { job: { role: true, organization: true } },
  });
  return gone({
    jobTitle: application?.job.role?.name ?? null,
    companyName: application?.job.organization?.name ?? null,
    companyEmail: application?.job.organization?.email ?? null,
  });
};

const findByToken = async (
  token: string
): Promise<{ row: ApplicationReference; questions: ReferenceQuestion[] }> => {
  const row = await repo().findOne({ where: { tokenHash: hashToken(token) } });
  const questions = row && row.sentAt ? questionsOf(row) : null;
  if (!row || !questions) throw new NotFoundError("Reference link not found");
  if (row.answeredAt || row.tokenExpiresAt.getTime() <= Date.now()) {
    throw await goneWithContext(row);
  }
  return { row, questions };
};

export const openReferenceLink = async (token: string) => {
  const { row, questions } = await findByToken(token);
  const application = await AppDataSource.getRepository(Application).findOneOrFail({
    where: { id: row.applicationId },
    relations: { job: { role: true, organization: true }, talent: true },
  });
  return {
    refereeName: row.name,
    candidateName: `${application.talent.firstName} ${application.talent.lastName}`.trim(),
    jobTitle: application.job.role?.name ?? "a job",
    companyName: application.job.organization?.name ?? null,
    expiresAt: row.tokenExpiresAt,
    questions: questions.map(({ key, question, required, type }) => ({
      key,
      question,
      required,
      type,
    })),
  };
};

const cleanAnswers = (questions: ReferenceQuestion[], raw: unknown): Record<string, string> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("answers are required");
  }
  const given = raw as Record<string, unknown>;
  const cleaned: Record<string, string> = {};
  for (const { key, required, type } of questions) {
    const value = typeof given[key] === "string" ? (given[key] as string).trim() : "";
    if (type === "yesno" && value && value !== "Yes" && value !== "No") {
      throw new ValidationError(`${key} must be Yes or No`);
    }
    if (value.length > REFERENCE_ANSWER_MAX_LENGTH) {
      throw new ValidationError(`${key} must be at most ${REFERENCE_ANSWER_MAX_LENGTH} characters`);
    }
    if (!value && required) throw new ValidationError(`${key} is required`);
    if (value) cleaned[key] = value;
  }
  return cleaned;
};

export const submitReferenceAnswers = async (token: string, rawAnswers: unknown) => {
  const { row, questions } = await findByToken(token);
  const answers = cleanAnswers(questions, rawAnswers);
  const updated = await repo()
    .createQueryBuilder()
    .update(ApplicationReference)
    .set({ answers, answeredAt: new Date() })
    .where("id = :id", { id: row.id })
    .andWhere("answered_at IS NULL")
    .andWhere("token_expires_at > now()")
    .returning(["id"])
    .execute();
  if (!(updated.raw as Array<{ id: string }>).length) throw await goneWithContext(row);
  return { answered: true };
};
