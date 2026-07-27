import { Not, IsNull } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { AIConfig } from "../entities/AIConfig.js";
import { Application } from "../entities/Application.js";
import { Job } from "../entities/Job.js";
import { User } from "../entities/User.js";
import { ApplicationStatus, ScreeningStage, MatchVerdict } from "../types/enums.js";
import { ValidationError } from "../utils/errors";
import { assessApplicationMatch } from "../utils/integrations/openai.js";
import logger from "../utils/logger.js";

const applicationRepo = () => AppDataSource.getRepository(Application);

const jobRepo = () => AppDataSource.getRepository(Job);

export const canTakeAssessment = (assessmentRetryDate: Date | null): boolean => {
  if (!assessmentRetryDate) return true;
  return new Date() >= assessmentRetryDate;
};

export const getAssessmentRetryDate = (days = 7): Date => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
};

export const rankApplication = async (talent: User, application: Application): Promise<void> => {
  const prescreeningScore = talent.prescreeningScore ?? undefined;
  const scores = [
    application.cvSimilarityScore,
    application.personalizedScore,
    prescreeningScore,
  ].filter((s): s is number => s !== null && s !== undefined);

  const averageScore =
    scores.length > 0 ? Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)) : 0;

  application.averageScore = averageScore;

  // Only count applications that have *already* been ranked (i.e. already
  // finished the pipeline) — counting every application for the job, as this
  // used to, includes talents still mid-pipeline and inflates rank past the
  // number of applicants who've actually completed (e.g. "rank 3 of 2").
  const newRank =
    (await applicationRepo().count({
      where: { jobId: application.jobId, rank: Not(IsNull()) },
    })) + 1;

  application.rank = newRank;
};

// Advisory only — never blocks the actual stage transition. Callers fire this
// without awaiting it so it doesn't delay the response; failures (including a
// missing/unparsable LLM response) are logged and swallowed rather than surfaced
// to the talent. Exported `async` (rather than void-returning) so tests can await
// it directly instead of racing the fire-and-forget call.
export const triggerMatchVerdict = async (
  talent: User,
  application: Application
): Promise<void> => {
  try {
    const job = await jobRepo().findOne({
      where: { id: application.jobId },
      relations: { aiConfig: true },
    });
    if (!job) return;

    const aiConfig = job.aiConfig as AIConfig | null;
    const response = await assessApplicationMatch({
      jobDescription: job.jobBrief,
      recruiterGuide: aiConfig?.recruiterGuide ?? undefined,
      cvSimilarityScore: application.cvSimilarityScore,
      personalizedScore: application.personalizedScore,
      prescreeningScore: talent.prescreeningScore ?? null,
      mbtiType: application.mbtiType,
    });
    if (!response?.message.content) {
      throw new ValidationError("Error with LLM");
    }

    const parsed = JSON.parse(response.message.content) as {
      verdict: string;
      reasoning: string;
    };

    // The LLM is instructed to return exactly "high"/"medium"/"low", but nothing
    // guarantees it does — an unvalidated write straight to this enum column was
    // the actual reason verdicts silently never appeared: any casing/wording
    // deviation ("High", etc.) failed the DB write, was swallowed by the catch
    // below, and left matchVerdict null forever with no visible error.
    const normalizedVerdict = parsed.verdict?.trim().toLowerCase();
    const validVerdicts = Object.values(MatchVerdict) as string[];
    if (!validVerdicts.includes(normalizedVerdict)) {
      throw new ValidationError(`Unexpected verdict value from LLM: "${parsed.verdict}"`);
    }

    await applicationRepo().update(application.id, {
      matchVerdict: normalizedVerdict as MatchVerdict,
      matchVerdictReasoning: parsed.reasoning,
    });
  } catch (err) {
    logger.error(
      `Match verdict generation failed for application ${application.id}: ${(err as Error).message}`
    );
  }
};

export const processNextStage = async (
  talent: User,
  application: Application,
  stage: ScreeningStage
): Promise<Application> => {
  const stages = application.stages ?? {};
  const nextStage = stages[stage];

  if (!nextStage) {
    throw new ValidationError("Next stage not found");
  }

  application.currentStage = nextStage as Application["currentStage"];

  if (nextStage === ScreeningStage.Completed) {
    await rankApplication(talent, application);
    application.status = ApplicationStatus.AwaitingDecision;
    void triggerMatchVerdict(talent, application);
  } else {
    application.status = ApplicationStatus.Pending;
  }

  return application;
};

// Advances every one of the talent's applications currently parked at the (global,
// job-agnostic) Prescreening stage, gated per-application by that job's own
// minPrescreeningScore — never mutates the global PreScreening/User.prescreeningScore.
export const advanceApplicationsAfterPrescreening = async (
  talent: User,
  prescreeningScore: number
): Promise<void> => {
  const apps = await applicationRepo().find({
    where: { talentId: talent.id, currentStage: ScreeningStage.Prescreening },
  });

  for (const application of apps) {
    const job = await jobRepo().findOne({
      where: { id: application.jobId },
      relations: { aiConfig: true },
    });
    const minScore = (job?.aiConfig as AIConfig | undefined)?.minPrescreeningScore ?? 0;

    let updated: Application;
    if (prescreeningScore < minScore) {
      application.status = ApplicationStatus.RetakeAssessment;
      application.assessmentRetryDate = getAssessmentRetryDate();
      updated = application;
    } else {
      updated = await processNextStage(talent, application, ScreeningStage.Prescreening);
    }
    await applicationRepo().save(updated);
  }
};
