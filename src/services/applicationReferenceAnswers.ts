import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { ApplicationReference } from "../entities/ApplicationReference.js";
import { AppError, NotFoundError, ValidationError } from "../utils/errors";
import { hashToken } from "./applicationReferences.js";

export const REFERENCE_ANSWER_MAX_LENGTH = 2000;

export const REFERENCE_QUESTIONS = [
  {
    key: "worked_together",
    question: "How did you work together?",
    required: true,
    type: "text",
  },
  { key: "strengths", question: "What are their strengths?", required: true, type: "text" },
  { key: "improve", question: "What could they improve?", required: true, type: "text" },
  { key: "reliability", question: "How reliable are they?", required: true, type: "text" },
  { key: "hire_again", question: "Would you hire them again?", required: true, type: "yesno" },
  {
    key: "anything_else",
    question: "Anything else you want us to know?",
    required: false,
    type: "text",
  },
] as const;

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

const findByToken = async (token: string): Promise<ApplicationReference> => {
  const row = await repo().findOne({ where: { tokenHash: hashToken(token) } });
  if (!row) throw new NotFoundError("Reference link not found");
  if (row.answeredAt || row.tokenExpiresAt.getTime() <= Date.now()) {
    throw await goneWithContext(row);
  }
  return row;
};

export const openReferenceLink = async (token: string) => {
  const row = await findByToken(token);
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
    questions: REFERENCE_QUESTIONS.map(({ key, question, required, type }) => ({
      key,
      question,
      required,
      type,
    })),
  };
};

const cleanAnswers = (raw: unknown): Record<string, string> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("answers are required");
  }
  const given = raw as Record<string, unknown>;
  const cleaned: Record<string, string> = {};
  for (const { key, required, type } of REFERENCE_QUESTIONS) {
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
  const row = await findByToken(token);
  const answers = cleanAnswers(rawAnswers);
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
