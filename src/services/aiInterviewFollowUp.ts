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

export const askFollowUpAfterAnswer = async (questionId: string): Promise<void> => {
  const questionRepo = AppDataSource.getRepository(AiInterviewQuestion);
  const question = await questionRepo.findOne({ where: { id: questionId } });
  if (!question || question.isFollowUp || !question.transcript) return;

  const interview = await AppDataSource.getRepository(AiInterview).findOne({
    where: { id: question.interviewId },
  });
  if (!interview) return;

  const followUps = await questionRepo.count({
    where: { interviewId: interview.id, isFollowUp: true },
  });
  if (followUps >= MAX_AI_INTERVIEW_FOLLOW_UPS) return;

  const alreadyFollowedUp = await questionRepo.count({
    where: { interviewId: interview.id, position: question.position, isFollowUp: true },
  });
  if (alreadyFollowedUp > 0) return;

  const job = await AppDataSource.getRepository(Job).findOne({
    where: { id: interview.jobId },
    relations: { role: true },
  });
  const reply = await generateAiInterviewFollowUp({
    roleName: job?.role?.name ?? "",
    jobBrief: job?.jobBrief ?? "",
    requirements: job?.requirements ?? null,
    question: question.question,
    answer: question.transcript,
  });
  const followUp = parseAiInterviewFollowUp(reply?.message?.content);
  if (!followUp) return;

  await questionRepo
    .createQueryBuilder()
    .insert()
    .values({
      interviewId: interview.id,
      position: question.position,
      isFollowUp: true,
      question: followUp,
    })
    .orIgnore()
    .execute();
};

export const askFollowUpSafely = async (questionId: string): Promise<void> => {
  try {
    await askFollowUpAfterAnswer(questionId);
  } catch (err) {
    logger.warn(
      `Interview follow-up skipped for question ${questionId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
};
