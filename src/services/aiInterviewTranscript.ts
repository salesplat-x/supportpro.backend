import { AppDataSource } from "../database/dataSource.js";
import { AiInterview } from "../entities/AiInterview.js";
import { AiInterviewQuestion } from "../entities/AiInterviewQuestion.js";
import { AppError, AuthorizationError, NotFoundError, ValidationError } from "../utils/errors";
import {
  claimRowById,
  durableFailureUpdate,
  errorMessage,
  MAX_DURABLE_ATTEMPTS,
  selectDueIds,
  STALE_LOCK_INTERVAL,
  SWEEP_BATCH_SIZE,
  type DurableFailureUpdate,
} from "../utils/durableJobs.js";
import logger from "../utils/logger.js";
import { getFromSpaces } from "../utils/integrations/spaces.js";
import { transcribe } from "./voice.js";
import { isPostingCompanyMember } from "./aiInterviewRecording.js";
import { askFollowUpSafely } from "./aiInterviewFollowUp.js";

const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
};

export const transcriptExtensionFor = (mimeType: string): string | null =>
  EXTENSIONS[mimeType] ?? null;

const DUE_TRANSCRIPT_SQL = `
  SELECT q."id" AS "id" FROM "ai_interview_questions" q
  WHERE q."transcript_status" = 'pending'
    AND q."recording_key" IS NOT NULL
    AND q."transcript_attempts" < $1
    AND (q."transcript_next_retry_at" IS NULL OR q."transcript_next_retry_at" <= NOW())
    AND (q."transcript_locked_at" IS NULL OR q."transcript_locked_at" < NOW() - INTERVAL '${STALE_LOCK_INTERVAL}')
  ORDER BY q."created_at"
  LIMIT $2
`;

const CLAIM_TRANSCRIPT_SQL = `
  UPDATE "ai_interview_questions"
  SET "transcript_locked_at" = NOW()
  WHERE "id" = $1
    AND "transcript_status" = 'pending'
    AND "recording_key" IS NOT NULL
    AND "transcript_attempts" < ${MAX_DURABLE_ATTEMPTS}
    AND ("transcript_next_retry_at" IS NULL OR "transcript_next_retry_at" <= NOW())
    AND ("transcript_locked_at" IS NULL OR "transcript_locked_at" < NOW() - INTERVAL '${STALE_LOCK_INTERVAL}')
  RETURNING "id"
`;

const questionRepo = () => AppDataSource.getRepository(AiInterviewQuestion);

const failureUpdate = (attempts: number, err: unknown): DurableFailureUpdate => {
  if (err instanceof ValidationError) {
    return {
      attempts: MAX_DURABLE_ATTEMPTS,
      nextRetryAt: null,
      lockedAt: null,
      lastError: errorMessage(err),
      exhausted: true,
    };
  }
  return durableFailureUpdate(
    attempts,
    err instanceof AppError ? new Error(errorMessage(err)) : err
  );
};

const recordFailure = async (questionId: string, recordingKey: string, err: unknown) => {
  const row = await questionRepo().findOne({
    where: { id: questionId },
    select: { id: true, transcriptAttempts: true },
  });
  if (!row) return;
  const patch = failureUpdate(row.transcriptAttempts, err);
  await questionRepo().update(
    { id: questionId, recordingKey },
    {
      transcriptStatus: patch.exhausted ? "failed" : "pending",
      transcriptAttempts: patch.attempts,
      transcriptNextRetryAt: patch.nextRetryAt,
      transcriptLockedAt: null,
      transcriptLastError: patch.lastError,
    }
  );
};

export const transcribeAnswerRecording = async (questionId: string): Promise<void> => {
  const claimed = await claimRowById(CLAIM_TRANSCRIPT_SQL, questionId);
  if (!claimed) return;

  const question = await questionRepo().findOne({ where: { id: questionId } });
  const recordingKey = question?.recordingKey;
  if (!question || !recordingKey) {
    await questionRepo().update(questionId, { transcriptLockedAt: null });
    return;
  }

  let saved = false;
  try {
    const extension = transcriptExtensionFor(question.recordingMimeType ?? "");
    if (!extension) {
      throw new ValidationError("This recording type can't be transcribed");
    }
    const buffer = await getFromSpaces(recordingKey);
    const transcript = await transcribe({ buffer, extension });
    await questionRepo().update(
      { id: questionId, recordingKey },
      {
        transcript,
        transcriptStatus: "completed",
        transcribedAt: new Date(),
        transcriptNextRetryAt: null,
        transcriptLockedAt: null,
        transcriptLastError: null,
      }
    );
    saved = true;
  } catch (err) {
    await recordFailure(questionId, recordingKey, err);
  }
  if (saved) await askFollowUpSafely(questionId);
};

export const reconcileDueInterviewTranscripts = async (): Promise<{ scanned: number }> => {
  const questionIds = await selectDueIds(DUE_TRANSCRIPT_SQL, [
    MAX_DURABLE_ATTEMPTS,
    SWEEP_BATCH_SIZE,
  ]);
  for (const questionId of questionIds) {
    try {
      await transcribeAnswerRecording(questionId);
    } catch (err) {
      logger.error(
        `Interview transcript job failed for question ${questionId}: ${errorMessage(err)}`
      );
    }
  }
  return { scanned: questionIds.length };
};

export const getCompanyInterviewTranscripts = async (userId: string, interviewId: string) => {
  const interview = await AppDataSource.getRepository(AiInterview).findOne({
    where: { id: interviewId },
  });
  if (!interview) throw new NotFoundError("Interview not found");
  if (!(await isPostingCompanyMember(userId, interview))) {
    throw new AuthorizationError("Only the company that posted this job can read its transcripts");
  }
  const rows = await questionRepo().find({
    where: { interviewId },
    order: { position: "ASC", isFollowUp: "ASC" },
  });
  return {
    interviewId: interview.id,
    questions: rows.map((row) => ({
      questionId: row.id,
      position: row.position,
      isFollowUp: row.isFollowUp,
      question: row.question,
      recorded: row.recordedAt !== null,
      transcriptStatus: row.transcriptStatus,
      transcript: row.transcript,
      transcribedAt: row.transcribedAt,
    })),
  };
};
