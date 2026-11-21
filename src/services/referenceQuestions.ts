import { randomUUID } from "crypto";
import { In } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { ApplicationReference } from "../entities/ApplicationReference.js";
import { Job } from "../entities/Job.js";
import { Organization } from "../entities/Organization.js";
import type { ReferenceQuestion, ReferenceQuestionType } from "../types/referenceQuestion.js";
import { AppError, AuthorizationError, ValidationError } from "../utils/errors";
import { generateReferenceQuestions } from "../utils/integrations/openai.js";
import logger from "../utils/logger.js";
import { newToken, sendReferenceEmail } from "./applicationReferences.js";
import { getActiveOrganizationId } from "./organizationScope.js";

export const MAX_REFERENCE_QUESTIONS = 15;
export const MAX_REFERENCE_QUESTION_LENGTH = 300;
export const MAX_GENERATED_QUESTIONS = 10;
export const REFERENCE_QUESTION_TYPES: readonly ReferenceQuestionType[] = ["text", "yesno"];

export interface ReferenceQuestionInput {
  key?: string;
  question: string;
  type: ReferenceQuestionType;
  required: boolean;
}

export interface JobWithWaitingReferees {
  jobId: string;
  title: string;
  status: string;
  createdAt: Date;
  waiting: number;
}

const referencesRepo = () => AppDataSource.getRepository(ApplicationReference);

const assertMember = async (userId: string, organizationId: string): Promise<void> => {
  if ((await getActiveOrganizationId(userId)) !== organizationId) {
    throw new AuthorizationError("Only members of this company can manage its reference questions");
  }
};

const questionsOfCompany = async (organizationId: string): Promise<ReferenceQuestion[]> => {
  const organization = await AppDataSource.getRepository(Organization).findOne({
    where: { id: organizationId },
    select: { id: true, referenceQuestions: true },
  });
  return organization?.referenceQuestions ?? [];
};

export const getCompanyQuestions = async (
  userId: string,
  organizationId: string
): Promise<ReferenceQuestion[]> => {
  await assertMember(userId, organizationId);
  return questionsOfCompany(organizationId);
};

export const setCompanyQuestions = async (
  userId: string,
  organizationId: string,
  items: ReferenceQuestionInput[]
): Promise<ReferenceQuestion[]> => {
  await assertMember(userId, organizationId);
  const seen = new Set<string>();
  const questions = items
    .filter((item) => item.question.trim().length > 0)
    .map((item) => {
      const key = item.key && !seen.has(item.key) ? item.key : randomUUID();
      seen.add(key);
      return { key, question: item.question.trim(), type: item.type, required: item.required };
    });
  if (questions.length > MAX_REFERENCE_QUESTIONS) {
    throw new ValidationError(`A company can have at most ${MAX_REFERENCE_QUESTIONS} questions`);
  }
  await AppDataSource.getRepository(Organization).update(organizationId, {
    referenceQuestions: questions.length ? questions : null,
  });
  return questions;
};

export const parseGeneratedQuestions = (
  content: string | null | undefined,
  count: number
): Array<Omit<ReferenceQuestion, "key">> | null => {
  if (!content) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const raw = (parsed as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw)) return null;
  const questions = raw
    .map((item) => {
      const value = item as { question?: unknown; type?: unknown } | null;
      const question = typeof value?.question === "string" ? value.question.trim() : "";
      const type: ReferenceQuestionType = value?.type === "yesno" ? "yesno" : "text";
      return { question, type, required: true };
    })
    .filter(
      (item) => item.question.length > 0 && item.question.length <= MAX_REFERENCE_QUESTION_LENGTH
    );
  return questions.length ? questions.slice(0, count) : null;
};

export const generateCompanyQuestions = async (
  userId: string,
  organizationId: string,
  count: number
): Promise<Array<Omit<ReferenceQuestion, "key">>> => {
  await assertMember(userId, organizationId);
  let questions: Array<Omit<ReferenceQuestion, "key">> | null = null;
  try {
    const reply = await generateReferenceQuestions(count);
    questions = parseGeneratedQuestions(reply?.message?.content, count);
  } catch (error) {
    logger.warn(`Reference questions failed for organization ${organizationId}: ${String(error)}`);
  }
  if (!questions) {
    throw new AppError(
      502,
      "REFERENCE_QUESTIONS_FAILED",
      "We couldn't write questions right now. Try again in a moment",
      true
    );
  }
  return questions;
};

const waitingQuery = (organizationId: string) =>
  referencesRepo()
    .createQueryBuilder("reference")
    .innerJoin("reference.job", "job")
    .where("job.organizationId = :organizationId", { organizationId })
    .andWhere("reference.sentAt IS NULL")
    .andWhere("reference.answeredAt IS NULL");

export const listJobsWithWaitingReferees = async (
  userId: string,
  organizationId: string
): Promise<JobWithWaitingReferees[]> => {
  await assertMember(userId, organizationId);
  const rows = await waitingQuery(organizationId)
    .innerJoin("job.role", "role")
    .select("job.id", "jobId")
    .addSelect("role.name", "title")
    .addSelect("job.status", "status")
    .addSelect("job.createdAt", "createdAt")
    .addSelect("COUNT(reference.id)", "waiting")
    .groupBy("job.id")
    .addGroupBy("role.name")
    .orderBy("job.createdAt", "DESC")
    .getRawMany<{
      jobId: string;
      title: string;
      status: string;
      createdAt: Date;
      waiting: string;
    }>();
  return rows.map((row) => ({ ...row, waiting: Number(row.waiting) }));
};

const claim = async (
  row: ApplicationReference,
  questions: ReferenceQuestion[]
): Promise<string | null> => {
  const { token, tokenHash, expiresAt } = newToken();
  const updated = await referencesRepo()
    .createQueryBuilder()
    .update(ApplicationReference)
    .set({ questions, tokenHash, tokenExpiresAt: expiresAt })
    .where("id = :id", { id: row.id })
    .andWhere("questions IS NULL")
    .andWhere("sent_at IS NULL")
    .andWhere("answered_at IS NULL")
    .returning(["id"])
    .execute();
  return (updated.raw as Array<{ id: string }>).length ? token : null;
};

export const sendQuestionsToJobs = async (
  userId: string,
  organizationId: string,
  jobIds: string[]
): Promise<{ sent: number; failed: number }> => {
  await assertMember(userId, organizationId);
  const questions = await questionsOfCompany(organizationId);
  if (!questions.length) {
    throw new ValidationError("Add at least one reference question before sending");
  }
  const ids = [...new Set(jobIds)];
  const owned = await AppDataSource.getRepository(Job).count({
    where: { id: In(ids), organizationId },
  });
  if (owned !== ids.length) {
    throw new AuthorizationError("You can only send questions for your company's jobs");
  }
  const rows = await waitingQuery(organizationId)
    .andWhere("reference.jobId IN (:...ids)", { ids })
    .andWhere("reference.questions IS NULL")
    .getMany();

  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const token = await claim(row, questions);
    if (!token) continue;
    const emailed = await sendReferenceEmail({ ...row, questions }, token);
    if (emailed) {
      sent += 1;
    } else {
      failed += 1;
      await referencesRepo().update(row.id, { questions: null });
    }
  }
  return { sent, failed };
};
