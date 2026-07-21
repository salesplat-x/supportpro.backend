import { AppDataSource } from "../database/dataSource.js";
import { AIConfig } from "../entities/AIConfig.js";
import { Application } from "../entities/Application.js";
import { Job } from "../entities/Job.js";
import { User } from "../entities/User.js";
import { ApplicationStatus, ScreeningStage } from "../types/enums.js";
import { ValidationError } from "../utils/errors";

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

  const newRank =
    (await applicationRepo().count({
      where: { jobId: application.jobId },
    })) + 1;

  application.rank = newRank;
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
    application.status = ApplicationStatus.Shortlisted;
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
