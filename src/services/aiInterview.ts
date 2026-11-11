import env from "../config/env.js";
import { AppDataSource } from "../database/dataSource.js";
import { AiInterview } from "../entities/AiInterview.js";
import { AiInterviewQuestion } from "../entities/AiInterviewQuestion.js";
import { Application } from "../entities/Application.js";
import { ScreeningStage } from "../types/enums.js";
import EmailService from "../utils/integrations/email/emailService.js";
import { generateAiInterviewQuestions } from "../utils/integrations/openai.js";
import logger from "../utils/logger.js";

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

export const startAiInterview = async (applicationId: string): Promise<void> => {
  const application = await AppDataSource.getRepository(Application).findOne({
    where: { id: applicationId },
    relations: { job: { aiConfig: true, role: true, organization: true }, talent: true },
  });
  const job = application?.job;
  const config = job?.aiConfig;
  if (!application || !job || !config?.aiInterview || !config.aiInterviewMode) return;

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
  if (!interviewId) return; // already started for this application

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
    return;
  }

  await AppDataSource.getRepository(AiInterviewQuestion).insert(
    questions.map((question, i) => ({ interviewId, position: i + 1, question }))
  );
  await interviews.update(interviewId, { status: "ready" });

  try {
    await new EmailService().sendAiInterviewInvite({
      to: application.talent.email,
      firstName: application.talent.firstName,
      jobTitle: job.role?.name ?? "the job",
      companyName: job.organization?.name,
      mode: config.aiInterviewMode,
      ctaUrl: `${env.website || "https://auxhr.com"}/talentDashboard/applicationPipeline/${job.id}`,
    });
    await interviews.update(interviewId, { status: "invited", invitedAt: new Date() });
  } catch (error) {
    logger.warn(`AI interview invite failed for application ${applicationId}: ${String(error)}`);
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
