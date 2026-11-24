import type { EntityManager } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { AiInterview } from "../entities/AiInterview.js";
import { AiInterviewQuestion } from "../entities/AiInterviewQuestion.js";
import { Job } from "../entities/Job.js";
import logger from "../utils/logger.js";
import { generateAiInterviewFollowUp } from "../utils/integrations/openai.js";

export const MAX_AI_INTERVIEW_FOLLOW_UPS = 2;
export const AI_FOLLOW_UP_MAX_CHARS = 300;

export const parseAiInterviewFollowUp = (content: string | null | undefined): string | null => {
  if (!content) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const followUp = (parsed as { followUp?: unknown }).followUp;
  if (typeof followUp !== "string") return null;
  const trimmed = followUp.trim();
  if (!trimmed || trimmed.length > AI_FOLLOW_UP_MAX_CHARS) return null;
  return trimmed;
};

const followUpCounts = async (em: EntityManager, question: AiInterviewQuestion) => {
  const repo = em.getRepository(AiInterviewQuestion);
  const [total, here] = await Promise.all([
    repo.count({ where: { interviewId: question.interviewId, isFollowUp: true } }),
    repo.count({
      where: { interviewId: question.interviewId, position: question.position, isFollowUp: true },
    }),
  ]);
  return { total, here };
};

/**
 * Asks the model whether a main answer needs a follow-up, using the transcript just made, so the
 * follow-up exists by the time the transcript is saved. Returns null when the interview has its
 * follow-ups already, none is needed, or the model fails: the transcript never waits on this.
 */
export const draftFollowUp = async (
  question: AiInterviewQuestion,
  transcript: string
): Promise<string | null> => {
  if (question.isFollowUp) return null;
  try {
    const { total, here } = await followUpCounts(AppDataSource.manager, question);
    if (total >= MAX_AI_INTERVIEW_FOLLOW_UPS || here > 0) return null;
    const interview = await AppDataSource.getRepository(AiInterview).findOne({
      where: { id: question.interviewId },
      select: { id: true, jobId: true },
    });
    if (!interview) return null;
    const job = await AppDataSource.getRepository(Job).findOne({
      where: { id: interview.jobId },
      relations: { role: true },
    });
    const reply = await generateAiInterviewFollowUp({
      roleName: job?.role?.name ?? "",
      jobBrief: job?.jobBrief ?? "",
      requirements: job?.requirements ?? null,
      question: question.question,
      answer: transcript,
    });
    return parseAiInterviewFollowUp(reply?.message?.content);
  } catch (err) {
    logger.warn(
      `Interview follow-up skipped for question ${question.id}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
};

/**
 * Saves the follow-up inside the transcript's transaction. The interview row is locked and the
 * follow-ups counted again, so two answers transcribed at once can't pass the limit.
 */
export const insertFollowUp = async (
  em: EntityManager,
  question: AiInterviewQuestion,
  followUp: string
): Promise<void> => {
  await em.query(`SELECT 1 FROM "ai_interviews" WHERE "id" = $1 FOR UPDATE`, [
    question.interviewId,
  ]);
  const { total, here } = await followUpCounts(em, question);
  if (total >= MAX_AI_INTERVIEW_FOLLOW_UPS || here > 0) return;
  await em
    .createQueryBuilder()
    .insert()
    .into(AiInterviewQuestion)
    .values({
      interviewId: question.interviewId,
      position: question.position,
      isFollowUp: true,
      question: followUp,
    })
    .orIgnore()
    .execute();
};
