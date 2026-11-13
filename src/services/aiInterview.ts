import env from "../config/env.js";
import { AppDataSource } from "../database/dataSource.js";
import { AiInterview } from "../entities/AiInterview.js";
import { AiInterviewQuestion } from "../entities/AiInterviewQuestion.js";
import { Application } from "../entities/Application.js";
import { ScreeningStage } from "../types/enums.js";
import EmailService from "../utils/integrations/email/emailService.js";
import { generateAiInterviewQuestions } from "../utils/integrations/openai.js";
import logger from "../utils/logger.js";
import { AIConfig } from "../entities/AIConfig.js";
import { loadApplicationProgress, type InterviewProgress } from "./applicationProgress.js";
import { normalizeInterviewFlags } from "./aiInterviewScoring.js";

export const AI_INTERVIEW_QUESTION_COUNT = 5;

export const parseAiInterviewQuestions = (content: string | null | undefined): string[] | null => {
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
    .filter((q): q is string => typeof q === "string")
    .map((q) => q.trim())
    .filter((q) => q.length > 0);
  if (questions.length < AI_INTERVIEW_QUESTION_COUNT) return null;
  return questions.slice(0, AI_INTERVIEW_QUESTION_COUNT);
};

export type AiInterviewStart = "skipped" | "failed" | "ready" | "invited";

export const startAiInterview = async (
  applicationId: string,
  options: { sendInvite?: boolean } = {}
): Promise<AiInterviewStart> => {
  const application = await AppDataSource.getRepository(Application).findOne({
    where: { id: applicationId },
    relations: { job: { aiConfig: true, role: true, organization: true }, talent: true },
  });
  const job = application?.job;
  const config = job?.aiConfig;
  if (!application || !job || !config?.aiInterview || !config.aiInterviewMode) return "skipped";

  const interviews = AppDataSource.getRepository(AiInterview);
  const inserted = await interviews
    .createQueryBuilder()
    .insert()
    .values({
      applicationId,
      jobId: job.id,
      talentId: application.talentId,
      mode: config.aiInterviewMode,
      status: "pending",
    })
    .orIgnore()
    .returning(["id"])
    .execute();
  const interviewId = (inserted.raw as Array<{ id: string }>)[0]?.id;
  if (!interviewId) return "skipped"; // already started for this application

  let questions: string[] | null = null;
  try {
    const reply = await generateAiInterviewQuestions({
      count: AI_INTERVIEW_QUESTION_COUNT,
      roleName: job.role?.name ?? "",
      jobBrief: job.jobBrief,
      requirements: job.requirements,
    });
    questions = parseAiInterviewQuestions(reply?.message?.content);
  } catch (error) {
    logger.warn(`AI interview questions failed for application ${applicationId}: ${String(error)}`);
  }
  if (!questions) {
    await interviews.update(interviewId, { status: "failed" });
    logger.warn(`AI interview for application ${applicationId} has no usable questions`);
    return "failed";
  }

  await AppDataSource.getRepository(AiInterviewQuestion).insert(
    questions.map((question, i) => ({ interviewId, position: i + 1, question }))
  );
  await interviews.update(interviewId, { status: "ready" });
  if (options.sendInvite === false) return "ready";

  try {
    await new EmailService().sendAiInterviewInvite({
      to: application.talent.email,
      firstName: application.talent.firstName,
      jobTitle: job.role?.name ?? "the job",
      companyName: job.organization?.name,
      mode: config.aiInterviewMode,
      ctaUrl: `${env.website || "https://auxhr.com"}/talentDashboard/interview/${interviewId}`,
    });
    await interviews.update(interviewId, { status: "invited", invitedAt: new Date() });
    return "invited";
  } catch (error) {
    logger.warn(`AI interview invite failed for application ${applicationId}: ${String(error)}`);
    return "ready";
  }
};

const inFlightAiInterviews = new Set<Promise<void>>();

export const drainInFlightAiInterviews = async (): Promise<void> => {
  for (let attempt = 0; attempt < 100 && inFlightAiInterviews.size > 0; attempt++) {
    await Promise.allSettled([...inFlightAiInterviews]);
  }
};

export const startAiInterviewIfReached = (application: Application, stage: string): void => {
  if (stage !== ScreeningStage.AiInterview) return;
  const task = (async () => {
    await new Promise((resolve) => setImmediate(resolve));
    await startAiInterview(application.id);
  })().catch((error) => {
    logger.warn(`AI interview start failed for application ${application.id}: ${String(error)}`);
  });
  inFlightAiInterviews.add(task);
  void task.finally(() => inFlightAiInterviews.delete(task));
};

export type NextStep = "ai_interview" | "shortlisted";

/** The recorded interview is the next step while the job runs one and this candidate has none. */
export const nextStepFor = async (application: Application): Promise<NextStep> => {
  const [config, existing] = await Promise.all([
    application.job?.aiConfigId
      ? AppDataSource.getRepository(AIConfig).findOne({
          where: { id: application.job.aiConfigId },
          select: { id: true, aiInterview: true, aiInterviewMode: true },
        })
      : null,
    AppDataSource.getRepository(AiInterview).findOne({
      where: { applicationId: application.id },
      select: { id: true, status: true },
    }),
  ]);
  const runsInterview = Boolean(config?.aiInterview && config.aiInterviewMode);
  const hasInterview = existing !== null && existing.status !== "failed";
  return runsInterview && !hasInterview ? "ai_interview" : "shortlisted";
};

export interface RecruiterInterview {
  id: string;
  mode: AiInterview["mode"];
  status: InterviewProgress;
  invitedAt: Date | null;
  startedAt: Date | null;
  scoringStatus: AiInterview["scoringStatus"];
  scores: AiInterview["scores"];
  summary: string | null;
  flags: ReturnType<typeof normalizeInterviewFlags>;
  scoredAt: Date | null;
  questions: Array<{
    id: string;
    position: number;
    isFollowUp: boolean;
    question: string;
    recorded: boolean;
    recordedAt: Date | null;
    durationSeconds: number | null;
    transcriptStatus: AiInterviewQuestion["transcriptStatus"];
    transcript: string | null;
  }>;
}

/** For the company only: callers check access first. */
export const getRecruiterInterview = async (
  applicationId: string
): Promise<RecruiterInterview | null> => {
  const interview = await AppDataSource.getRepository(AiInterview).findOne({
    where: { applicationId },
  });
  if (!interview || interview.status === "failed") return null;
  const [rows, progress] = await Promise.all([
    AppDataSource.getRepository(AiInterviewQuestion).find({
      where: { interviewId: interview.id },
      order: { position: "ASC", isFollowUp: "ASC" },
    }),
    loadApplicationProgress([applicationId]),
  ]);
  const recordedTimes = rows
    .map((row) => row.recordedAt?.getTime())
    .filter((time): time is number => time !== undefined);
  return {
    id: interview.id,
    mode: interview.mode,
    status: progress.get(applicationId)?.interview.status ?? "not_started",
    invitedAt: interview.invitedAt,
    startedAt: recordedTimes.length ? new Date(Math.min(...recordedTimes)) : null,
    scoringStatus: interview.scoringStatus,
    scores: interview.scores,
    summary: interview.summary,
    flags: normalizeInterviewFlags(interview.flags),
    scoredAt: interview.scoredAt,
    questions: rows.map((row) => ({
      id: row.id,
      position: row.position,
      isFollowUp: row.isFollowUp,
      question: row.question,
      recorded: row.recordedAt !== null,
      recordedAt: row.recordedAt,
      durationSeconds: row.recordingDurationSeconds,
      transcriptStatus: row.transcriptStatus,
      transcript: row.transcript,
    })),
  };
};
