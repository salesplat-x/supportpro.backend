import { AppDataSource } from "../database/dataSource.js";
import { AiInterview } from "../entities/AiInterview.js";
import { AiInterviewQuestion } from "../entities/AiInterviewQuestion.js";
import { Job } from "../entities/Job.js";
import { IsNull } from "typeorm";
import {
  AppError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../utils/errors";
import {
  deleteSpacesObjectQuietly,
  getFromSpaces,
  isSpacesConfigured,
  spacesKeyFor,
  uploadPrivateToSpaces,
} from "../utils/integrations/spaces.js";
import { getActiveOrganizationId } from "./organizationScope.js";
import { probeAudioDurationSeconds } from "../utils/audioDuration.js";
import logger from "../utils/logger.js";

export interface RecordingFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

const notSetUp = () =>
  new AppError(503, "RECORDING_STORAGE_NOT_CONFIGURED", "Recording storage is not set up yet");

const loadQuestion = async (interviewId: string, questionId: string) => {
  const interview = await AppDataSource.getRepository(AiInterview).findOne({
    where: { id: interviewId },
  });
  if (!interview) throw new NotFoundError("Interview not found");
  const question = await AppDataSource.getRepository(AiInterviewQuestion).findOne({
    where: { id: questionId, interviewId },
  });
  if (!question) throw new NotFoundError("Question not found in this interview");
  return { interview, question };
};

export const isPostingCompanyMember = async (
  userId: string,
  interview: AiInterview
): Promise<boolean> => {
  const job = await AppDataSource.getRepository(Job).findOne({
    where: { id: interview.jobId },
    select: { id: true, organizationId: true, postedById: true },
  });
  if (!job) return false;
  if (job.organizationId) {
    return (await getActiveOrganizationId(userId)) === job.organizationId;
  }
  return job.postedById === userId;
};

const measureSeconds = async (buffer: Buffer, mimeType: string): Promise<number | null> => {
  try {
    return await probeAudioDurationSeconds(buffer, mimeType.split("/")[1] ?? "webm");
  } catch (err) {
    logger.warn(`Interview recording length unreadable: ${(err as Error).message}`);
    return null;
  }
};

const canOpen = async (userId: string, interview: AiInterview): Promise<boolean> => {
  if (interview.talentId === userId) return true;
  return isPostingCompanyMember(userId, interview);
};

export const saveRecording = async (
  userId: string,
  interviewId: string,
  questionId: string,
  file: RecordingFile | undefined
): Promise<{ questionId: string; recordedAt: Date; size: number; mimeType: string }> => {
  const { interview, question } = await loadQuestion(interviewId, questionId);
  if (interview.talentId !== userId) {
    throw new AuthorizationError("Only the candidate can upload answers to this interview");
  }
  if (!file) throw new ValidationError("Attach the recording as 'recording'");
  const mimeType = (file.mimetype.split(";")[0] ?? "").trim().toLowerCase();
  if (interview.mode === "audio" && mimeType.startsWith("video/")) {
    throw new ValidationError("This interview is audio only, so upload an audio recording");
  }
  if (!isSpacesConfigured()) throw notSetUp();

  const key = spacesKeyFor("interview-recordings", interview.id, file.originalname);
  const [, durationSeconds] = await Promise.all([
    uploadPrivateToSpaces(file.buffer, key, mimeType),
    measureSeconds(file.buffer, mimeType),
  ]);

  const recordedAt = new Date();
  const saved = await AppDataSource.getRepository(AiInterviewQuestion).update(
    { id: question.id, recordedAt: IsNull() },
    {
      recordingKey: key,
      recordingMimeType: mimeType,
      recordingSize: file.size,
      recordingDurationSeconds: durationSeconds,
      recordedAt,
      transcriptStatus: "pending",
      transcript: null,
      transcribedAt: null,
      transcriptAttempts: 0,
      transcriptNextRetryAt: null,
      transcriptLockedAt: null,
      transcriptLastError: null,
    }
  );
  if (!saved.affected) {
    await deleteSpacesObjectQuietly(key, `second answer to interview question ${question.id}`);
    throw new ConflictError("This question is already answered");
  }
  await AppDataSource.getRepository(AiInterview).update(interview.id, {
    scoringStatus: null,
    scores: null,
    summary: null,
    flags: null,
    scoredAt: null,
    scoringAttempts: 0,
    scoringNextRetryAt: null,
    scoringLockedAt: null,
    scoringLastError: null,
  });
  return { questionId: question.id, recordedAt, size: file.size, mimeType };
};

export const openRecording = async (
  userId: string,
  interviewId: string,
  questionId: string
): Promise<{ buffer: Buffer; mimeType: string }> => {
  const { interview, question } = await loadQuestion(interviewId, questionId);
  if (!(await canOpen(userId, interview))) {
    throw new AuthorizationError("You can't open this recording");
  }
  if (!question.recordingKey) throw new NotFoundError("No recording has been uploaded yet");
  if (!isSpacesConfigured()) throw notSetUp();
  const buffer = await getFromSpaces(question.recordingKey);
  return { buffer, mimeType: question.recordingMimeType ?? "application/octet-stream" };
};
