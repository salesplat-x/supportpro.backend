import { AppDataSource } from "../database/dataSource.js";
import { AiInterview, type AiInterviewScores } from "../entities/AiInterview.js";
import { AiInterviewQuestion } from "../entities/AiInterviewQuestion.js";
import { Job } from "../entities/Job.js";
import { AuthorizationError, NotFoundError, ValidationError } from "../utils/errors";
import {
  claimRowById,
  durableFailureUpdate,
  errorMessage,
  MAX_DURABLE_ATTEMPTS,
  selectDueIds,
  STALE_LOCK_INTERVAL,
  SWEEP_BATCH_SIZE,
} from "../utils/durableJobs.js";
import logger from "../utils/logger.js";
import { scoreAiInterviewAnswers } from "../utils/integrations/openai.js";
import { isPostingCompanyMember } from "./aiInterviewRecording.js";

const SCORE_REASON_MAX_CHARS = 300;
const SUMMARY_MAX_CHARS = 1000;
const MAX_FLAGS = 5;
const FLAG_MAX_CHARS = 200;

export interface InterviewAssessment {
  scores: AiInterviewScores;
  summary: string;
  flags: string[];
}

const unusable = (what: string) => new ValidationError(`The scoring reply was unusable: ${what}`);

const parseScore = (value: unknown, key: string) => {
  const entry = value as { score?: unknown; reason?: unknown } | null | undefined;
  if (!entry || typeof entry !== "object") throw unusable(key);
  const { score, reason } = entry;
  if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 5) {
    throw unusable(`${key} score`);
  }
  if (
    typeof reason !== "string" ||
    !reason.trim() ||
    reason.trim().length > SCORE_REASON_MAX_CHARS
  ) {
    throw unusable(`${key} reason`);
  }
  return { score, reason: reason.trim() };
};

export const parseInterviewAssessment = (
  content: string | null | undefined
): InterviewAssessment => {
  if (!content) throw unusable("empty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw unusable("not JSON");
  }
  if (!parsed || typeof parsed !== "object") throw unusable("not an object");
  const body = parsed as Record<string, unknown>;
  const scores: AiInterviewScores = {
    clearSpeaking: parseScore(body["clearSpeaking"], "clearSpeaking"),
    fitForRole: parseScore(body["fitForRole"], "fitForRole"),
    confidence: parseScore(body["confidence"], "confidence"),
  };
  const summary = typeof body["summary"] === "string" ? body["summary"].trim() : "";
  if (!summary || summary.length > SUMMARY_MAX_CHARS) throw unusable("summary");
  const rawFlags = body["flags"];
  if (
    !Array.isArray(rawFlags) ||
    rawFlags.length > MAX_FLAGS ||
    rawFlags.some(
      (flag) => typeof flag !== "string" || !flag.trim() || flag.trim().length > FLAG_MAX_CHARS
    )
  ) {
    throw unusable("flags");
  }
  return { scores, summary, flags: rawFlags.map((flag: string) => flag.trim()) };
};

const READY_FOR_SCORING_SQL = `
  UPDATE "ai_interviews" AS i
  SET "scoring_status" = 'pending'
  WHERE i."scoring_status" IS NULL
    AND EXISTS (
      SELECT 1 FROM "ai_interview_questions" q
      WHERE q."interview_id" = i."id" AND q."transcript_status" = 'completed'
    )
    AND NOT EXISTS (
      SELECT 1 FROM "ai_interview_questions" q
      WHERE q."interview_id" = i."id"
        AND (q."recorded_at" IS NULL OR q."transcript_status" = 'pending')
    )
`;

const DUE_SCORING_SQL = `
  SELECT i."id" AS "id" FROM "ai_interviews" i
  WHERE i."scoring_status" = 'pending'
    AND i."scoring_attempts" < $1
    AND (i."scoring_next_retry_at" IS NULL OR i."scoring_next_retry_at" <= NOW())
    AND (i."scoring_locked_at" IS NULL OR i."scoring_locked_at" < NOW() - INTERVAL '${STALE_LOCK_INTERVAL}')
  ORDER BY i."created_at"
  LIMIT $2
`;

const CLAIM_SCORING_SQL = `
  UPDATE "ai_interviews"
  SET "scoring_locked_at" = NOW()
  WHERE "id" = $1
    AND "scoring_status" = 'pending'
    AND "scoring_attempts" < ${MAX_DURABLE_ATTEMPTS}
    AND ("scoring_next_retry_at" IS NULL OR "scoring_next_retry_at" <= NOW())
    AND ("scoring_locked_at" IS NULL OR "scoring_locked_at" < NOW() - INTERVAL '${STALE_LOCK_INTERVAL}')
  RETURNING "id"
`;

const interviewRepo = () => AppDataSource.getRepository(AiInterview);

const scoreInterview = async (interviewId: string): Promise<void> => {
  const claimed = await claimRowById(CLAIM_SCORING_SQL, interviewId);
  if (!claimed) return;

  try {
    const interview = await interviewRepo().findOneByOrFail({ id: interviewId });
    const job = await AppDataSource.getRepository(Job).findOne({
      where: { id: interview.jobId },
      relations: { role: true },
    });
    const rows = await AppDataSource.getRepository(AiInterviewQuestion).find({
      where: { interviewId, transcriptStatus: "completed" },
      order: { position: "ASC", isFollowUp: "ASC" },
    });
    const answers = rows
      .filter((row) => row.transcript)
      .map((row) => ({
        position: row.position,
        question: row.question,
        transcript: row.transcript as string,
      }));
    if (answers.length === 0) throw new ValidationError("No answer has a transcript to score");

    const reply = await scoreAiInterviewAnswers({
      roleName: job?.role?.name ?? "",
      jobBrief: job?.jobBrief ?? "",
      requirements: job?.requirements ?? null,
      answers,
    });
    const assessment = parseInterviewAssessment(reply?.message?.content);
    await interviewRepo().update(interviewId, {
      scoringStatus: "completed",
      scores: assessment.scores,
      summary: assessment.summary,
      flags: assessment.flags,
      scoredAt: new Date(),
      scoringLockedAt: null,
      scoringNextRetryAt: null,
      scoringLastError: null,
    });
  } catch (err) {
    const row = await interviewRepo().findOne({
      where: { id: interviewId },
      select: { id: true, scoringAttempts: true },
    });
    if (!row) return;
    const patch = durableFailureUpdate(row.scoringAttempts, err);
    await interviewRepo().update(interviewId, {
      scoringStatus: patch.exhausted ? "failed" : "pending",
      scoringAttempts: patch.attempts,
      scoringNextRetryAt: patch.nextRetryAt,
      scoringLockedAt: null,
      scoringLastError: patch.lastError,
    });
  }
};

export const reconcileDueInterviewScoring = async (): Promise<{ scanned: number }> => {
  await AppDataSource.query(READY_FOR_SCORING_SQL);
  const interviewIds = await selectDueIds(DUE_SCORING_SQL, [
    MAX_DURABLE_ATTEMPTS,
    SWEEP_BATCH_SIZE,
  ]);
  for (const interviewId of interviewIds) {
    try {
      await scoreInterview(interviewId);
    } catch (err) {
      logger.error(
        `Interview scoring job failed for interview ${interviewId}: ${errorMessage(err)}`
      );
    }
  }
  return { scanned: interviewIds.length };
};

export const getCompanyInterviewAssessment = async (userId: string, interviewId: string) => {
  const interview = await interviewRepo().findOne({ where: { id: interviewId } });
  if (!interview) throw new NotFoundError("Interview not found");
  if (!(await isPostingCompanyMember(userId, interview))) {
    throw new AuthorizationError("Only the company that posted this job can read its assessment");
  }
  return {
    interviewId: interview.id,
    status: interview.scoringStatus,
    scores: interview.scores,
    summary: interview.summary,
    flags: interview.flags,
    scoredAt: interview.scoredAt,
  };
};
