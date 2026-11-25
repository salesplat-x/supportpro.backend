import { In } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { Notification } from "../entities/Notification.js";
import { User } from "../entities/User.js";
import { AiInterview } from "../entities/AiInterview.js";
import { Organization } from "../entities/Organization.js";
import {
  AppError,
  ConflictError,
  NotFoundError,
  PlanLimitError,
  ValidationError,
} from "../utils/errors";
import {
  UserRole,
  ApplicationType,
  ApplicationStatus,
  ScreeningStage,
  QuestionType,
  MatchVerdictStatus,
} from "../types/enums.js";
import { requestConsentOnShortlist } from "./checkConsent.js";
import { applicationLink, notifyTalent, TALENT_NOTIFICATION } from "./talentNotifications.js";
import { decisionNotificationTitle } from "./applicationNotifications.js";
import {
  loadApplicationWithMatch,
  loadRecommendationsByApplicationIds,
  overlayVerdictFromRecommendation,
  buildQuestionAnswerPairs,
  buildGradedAnswerPairs,
  triggerMatchVerdict,
} from "./applicationStage.js";
import logger from "../utils/logger.js";
import { STALE_LOCK_MS } from "../utils/durableJobs.js";
import { savePersonalityFit } from "./answer.js";
import { assertCompanyResourceAccess, getActiveOrganizationId } from "./organizationScope.js";
import { ensureOrganizationBillingCurrent, hasFlag } from "./entitlements.js";
import {
  type AiInterviewStart,
  getRecruiterInterview,
  type NextStep,
  nextStepFor,
  startAiInterview,
} from "./aiInterview.js";
import { deliverApplicantMessage } from "./message.js";
import {
  type ApplicationProgress,
  loadApplicationProgress,
  NO_PROGRESS,
  type WaitingFor,
} from "./applicationProgress.js";

const notificationRepo = () => AppDataSource.getRepository(Notification);

const applicationRepo = () => AppDataSource.getRepository(Application);

const organizationRepo = () => AppDataSource.getRepository(Organization);

// Candidates never see how they were scored: the CV match score, anything built from it, or
// the AI's judgement of their fit.
export const CANDIDATE_HIDDEN_APPLICATION_FIELDS = [
  "problemSolvingScore",
  "cultureFitScore",
  "personalityFitScore",
  "personalityFitReason",
  "personalityFitLockedAt",
  "cvSimilarityScore",
  "cvSimilarityAttempts",
  "averageScore",
  "overallFitScore",
  "matchVerdict",
  "matchVerdictStatus",
  "matchVerdictAttempts",
  "matchVerdictNextRetryAt",
  "matchVerdictLockedAt",
  "matchVerdictLastError",
  "matchVerdictReasoning",
  "matchRecommendation",
  "matchStrengths",
  "matchWeaknesses",
  "matchRisks",
  "matchAnalysis",
] as const;

export const hideAssessmentResultsFromCandidate = (application: Application): Application => {
  Object.assign(application, {
    problemSolvingSubmitted: application.problemSolvingScore != null,
    cultureFitSubmitted: application.cultureFitScore != null,
  });
  for (const field of CANDIDATE_HIDDEN_APPLICATION_FIELDS) {
    delete (application as Partial<Application> & { matchAnalysis?: unknown })[field];
  }
  return application;
};

/** True while a personality fit AI call holds a fresh lock on the application. */
export const isPersonalityFitPending = (application: Application): boolean =>
  application.personalityFitScore == null &&
  application.personalityFitLockedAt != null &&
  Date.now() - new Date(application.personalityFitLockedAt).getTime() < STALE_LOCK_MS;

/**
 * Lets the job's company ask the AI again for a personality fit that is
 * missing (the first try failed). One call at a time per application.
 */
export const retryPersonalityFit = async (
  userId: string,
  userRole: UserRole,
  applicationId: string
): Promise<{ personalityFitScore: number; personalityFitReason: string }> => {
  const application = await applicationRepo().findOne({
    where: { id: applicationId },
    relations: { job: { aiConfig: true } },
  });
  if (!application) {
    throw new NotFoundError("Application not found");
  }
  await assertCompanyResourceAccess(
    userId,
    userRole,
    application.job.organizationId,
    application.job.postedById
  );
  if (application.personalityFitScore != null) {
    return {
      personalityFitScore: application.personalityFitScore,
      personalityFitReason: application.personalityFitReason ?? "",
    };
  }
  if (!application.mbtiType) {
    throw new ValidationError("The candidate hasn't finished the personality test yet");
  }
  if (!application.job.aiConfig?.personalityEvaluation) {
    throw new ValidationError("The personality test is switched off for this job");
  }

  const outcome = await savePersonalityFit(application.id);
  if (outcome.status === "busy") {
    throw new ConflictError("The personality fit is already being worked out. Try again shortly.");
  }
  if (outcome.status === "failed") {
    throw new AppError(
      502,
      "PERSONALITY_FIT_FAILED",
      "We couldn't work out the personality fit right now. Please try again in a moment."
    );
  }
  return {
    personalityFitScore: outcome.personalityFitScore,
    personalityFitReason: outcome.personalityFitReason,
  };
};

const MAX_PAGE_SIZE = 100;

export interface FetchApplicationsParams {
  applicationType?: ApplicationType;
  applicationStatus?: ApplicationStatus;
  limit?: number | string;
  offset?: number | string;
  sort?: string;
}

export const getApplication = async (
  userId: string,
  userRole: UserRole,
  applicationId: string
): Promise<{ application: Application; count: number }> => {
  const application = await loadApplicationWithMatch(applicationId, {
    job: { postedBy: true },
    talent: true,
    role: true,
  });

  if (!application) {
    throw new NotFoundError("Application not found");
  }

  if (application.talentId !== userId) {
    await assertCompanyResourceAccess(
      userId,
      userRole,
      application.job.organizationId,
      application.job.postedById
    );
  }

  const count = await applicationRepo().count({
    where: {
      currentStage: ScreeningStage.Completed,
      jobId: application.jobId,
    },
  });

  const [personalityAnswers, personalizedAnswers] = await Promise.all([
    buildQuestionAnswerPairs(application.jobId, application.talentId, QuestionType.Personality),
    buildQuestionAnswerPairs(application.jobId, application.talentId, QuestionType.Personalized),
  ]);

  Object.assign(application, { personalityAnswers, personalizedAnswers });

  const isCandidate = application.talentId === userId;
  if (!isCandidate) {
    const [problemSolvingAnswers, cultureFitAnswers] = await Promise.all([
      buildGradedAnswerPairs(application.jobId, application.talentId, QuestionType.ProblemSolving),
      buildGradedAnswerPairs(application.jobId, application.talentId, QuestionType.CultureFit),
    ]);
    const [interview, nextStep, progress] = await Promise.all([
      getRecruiterInterview(application.id),
      nextStepFor(application),
      progressOf(application.id),
    ]);
    Object.assign(application, {
      problemSolvingAnswers,
      cultureFitAnswers,
      personalityFitPending: isPersonalityFitPending(application),
      interview,
      nextStep,
      readyForReview: progress.readyForReview,
      waitingFor: progress.waitingFor,
      canStartInterview: progress.canStartInterview,
      belowCvMinimum: progress.belowCvMinimum,
    });
  }

  if (
    application.currentStage === ScreeningStage.Completed &&
    !application.matchVerdict &&
    application.talent
  ) {
    if (application.matchVerdictStatus !== MatchVerdictStatus.Pending) {
      await applicationRepo().update(application.id, {
        matchVerdictStatus: MatchVerdictStatus.Pending,
      });
      application.matchVerdictStatus = MatchVerdictStatus.Pending;
    }
    // Its own copy: the verdict reads these fields after the candidate's view hides them below.
    void triggerMatchVerdict(application.talent, { ...application } as Application);
  }

  if (isCandidate) hideAssessmentResultsFromCandidate(application);
  return { application, count };
};

export const getApplications = async (
  userId: string,
  userRole: UserRole,
  payload: FetchApplicationsParams
): Promise<Application[]> => {
  const limit = Math.min(Number(payload.limit) || 50, MAX_PAGE_SIZE);
  const offset = Number(payload.offset) || 0;

  const qb = applicationRepo()
    .createQueryBuilder("application")
    .leftJoinAndSelect("application.job", "job")
    .leftJoinAndSelect("application.talent", "talent")
    .leftJoinAndSelect("application.role", "role");

  if (userRole === UserRole.Recruiter) {
    const activeOrgId = await getActiveOrganizationId(userId);
    if (!activeOrgId) {
      qb.where("application.recruiter_id = :userId", { userId });
    } else {
      qb.where("job.organization_id = :activeOrgId", { activeOrgId });
    }
  } else if (userRole === UserRole.Talent) {
    qb.where("application.talent_id = :userId", { userId });
  }

  if (payload.applicationType) {
    qb.andWhere("application.applicationType = :applicationType", {
      applicationType: payload.applicationType,
    });
  }

  if (payload.applicationStatus) {
    qb.andWhere("application.status = :applicationStatus", {
      applicationStatus: payload.applicationStatus,
    });
  }

  const applications = await qb.skip(offset).take(limit).getMany();
  const recommendations = await loadRecommendationsByApplicationIds(applications.map((a) => a.id));
  const withVerdicts = applications.map((application) =>
    overlayVerdictFromRecommendation(application, recommendations.get(application.id))
  );
  if (userRole === UserRole.Talent) withVerdicts.forEach(hideAssessmentResultsFromCandidate);
  return withVerdicts;
};

export interface DecisionEmail {
  send: boolean;
  body: string;
}

const progressOf = async (applicationId: string): Promise<ApplicationProgress> =>
  (await loadApplicationProgress([applicationId])).get(applicationId) ?? NO_PROGRESS;

const WAITING_FOR_LABEL: Record<WaitingFor, string> = {
  [ScreeningStage.Prescreening]: "the pre-assessment",
  [ScreeningStage.CvSimilarity]: "the CV match",
  [ScreeningStage.Personalized]: "the tailored questions",
  [ScreeningStage.ProblemSolving]: "the problem-solving test",
  [ScreeningStage.CultureFit]: "the culture-fit test",
  [ScreeningStage.Personality]: "the personality test",
  [ScreeningStage.AiInterview]: "the AI interview",
  [ScreeningStage.Completed]: "the last step",
  references: "at least one referee",
};

/** Shortlisting is the company review, the last step: only for candidates who finished every other one. */
const assertReadyForReview = (progress: ApplicationProgress): void => {
  if (progress.readyForReview) return;
  const waiting = progress.waitingFor ? WAITING_FOR_LABEL[progress.waitingFor] : "their next step";
  throw new AppError(
    422,
    "STEPS_NOT_FINISHED",
    `This candidate can't be shortlisted until they finish every application step. Still waiting for ${waiting}.`
  );
};

export const updateStatus = async (
  userId: string,
  payload: { id: string; status: ApplicationStatus; email?: DecisionEmail }
): Promise<Application> => {
  const application = await applicationRepo().findOne({
    where: { id: payload.id },
    relations: { job: { role: true, organization: true }, talent: true },
  });

  if (!application) {
    throw new NotFoundError("Application not found");
  }

  if (application.talentId !== userId) {
    await assertCompanyResourceAccess(
      userId,
      UserRole.Recruiter,
      application.job.organizationId,
      application.job.postedById
    );
  }

  if (
    payload.status === ApplicationStatus.Shortlisted &&
    application.status !== ApplicationStatus.Shortlisted
  ) {
    assertReadyForReview(await progressOf(application.id));
  }

  application.status = payload.status;
  const saved = await applicationRepo().save(application);

  if (
    payload.status === ApplicationStatus.Rejected ||
    payload.status === ApplicationStatus.Shortlisted
  ) {
    // A single-row insert with no external dependency — cheap enough to await
    // directly (unlike the AI verdict/bulk fan-outs, which are fire-and-forget
    // because they're slow or high-volume). A failure here must never fail the
    // status update itself, so it's caught and logged rather than rethrown.
    try {
      const jobTitle = application.job.role?.name;
      const companyName = application.job.organization?.name;
      const title = decisionNotificationTitle(payload.status, jobTitle, companyName);
      await notifyTalent({
        userId: application.talentId,
        type: TALENT_NOTIFICATION.ApplicationUpdate,
        title,
        message: title,
        link: applicationLink(application.id),
      });
    } catch (err) {
      logger.error(
        `Decision notification failed for application ${application.id}: ${(err as Error).message}`
      );
    }
  }

  if (payload.status === ApplicationStatus.Shortlisted) {
    await requestConsentOnShortlist(application);
  }

  if (payload.status === ApplicationStatus.Rejected && payload.email?.send) {
    await sendRejectionEmail(userId, application, payload.email.body);
  }

  return saved;
};

const sendRejectionEmail = async (
  senderId: string,
  application: Application,
  body: string
): Promise<void> => {
  const sender = await AppDataSource.getRepository(User).findOne({ where: { id: senderId } });
  if (!sender) return;
  const jobTitle = application.job.role?.name ?? "the role";
  await deliverApplicantMessage({
    sender,
    application,
    content: body.trim(),
    subject: `Update on your application for ${jobTitle}`,
    sendEmail: true,
    jobTitle,
    companyName: application.job.organization?.name,
  });
};

export interface AdvanceResult {
  application: Application;
  nextStep: NextStep;
  interview: AiInterviewStart | null;
}

/**
 * Move forward: start the recorded interview when it is the candidate's next step, otherwise
 * shortlist a candidate who finished every step. The invite email goes out only when the
 * recruiter asks for it.
 */
export const advanceApplication = async (
  userId: string,
  payload: { id: string; sendInterviewInvite: boolean }
): Promise<AdvanceResult> => {
  const application = await applicationRepo().findOne({
    where: { id: payload.id },
    relations: { job: true },
  });
  if (!application) throw new NotFoundError("Application not found");
  await assertCompanyResourceAccess(
    userId,
    UserRole.Recruiter,
    application.job.organizationId,
    application.job.postedById
  );
  if (application.status === ApplicationStatus.Rejected) {
    throw new ValidationError("This candidate was rejected, so they can't move forward");
  }

  const progress = await progressOf(application.id);
  if (progress.canStartInterview) {
    await AppDataSource.getRepository(AiInterview).delete({
      applicationId: application.id,
      status: "failed",
    });
    const interview = await startAiInterview(application.id, {
      sendInvite: payload.sendInterviewInvite,
    });
    return { application, nextStep: "ai_interview", interview };
  }

  const saved =
    application.status === ApplicationStatus.Shortlisted
      ? application
      : await updateStatus(userId, { id: application.id, status: ApplicationStatus.Shortlisted });
  return { application: saved, nextStep: "shortlisted", interview: null };
};

// Applications the caller doesn't own are silently skipped rather than failing
// the whole batch — a recruiter selecting rows from their own job list can never
// pass in someone else's application ID by mistake, so a partial-success result
// is the expected outcome, not an error condition.
export const bulkUpdateStatus = async (
  userId: string,
  payload: {
    applicationIds: string[];
    status: ApplicationStatus.Rejected | ApplicationStatus.Shortlisted;
  }
): Promise<{ updated: number; skipped: number }> => {
  const activeOrgId = await getActiveOrganizationId(userId);
  if (activeOrgId) {
    let org = await organizationRepo().findOne({ where: { id: activeOrgId } });
    if (org) {
      org = await ensureOrganizationBillingCurrent(org);
      if (!hasFlag(org, "bulk_broadcast_tools")) {
        throw new PlanLimitError(
          "Bulk pipeline actions require a Pro plan or higher. Ask your organization owner to upgrade.",
          "bulk_broadcast_tools",
          org.billingPlan
        );
      }
    }
  }

  const applications = await applicationRepo().find({
    where: { id: In(payload.applicationIds) },
    relations: { job: { role: true, organization: true } },
  });

  const owned = applications.filter((application) =>
    application.job.organizationId
      ? application.job.organizationId === activeOrgId
      : application.job.postedById === userId
  );
  if (owned.length === 0) {
    throw new NotFoundError("No applications found");
  }

  // Shortlisting skips candidates who haven't finished every step; rejecting never waits.
  let eligible = owned;
  if (payload.status === ApplicationStatus.Shortlisted) {
    const progress = await loadApplicationProgress(owned.map((application) => application.id));
    eligible = owned.filter(
      (application) =>
        application.status === ApplicationStatus.Shortlisted ||
        progress.get(application.id)?.readyForReview
    );
  }

  const changing = eligible.filter((application) => application.status !== payload.status);

  for (const application of eligible) {
    application.status = payload.status;
  }
  await applicationRepo().save(eligible);

  const notifications = changing.map((application) => {
    const jobTitle = application.job.role?.name;
    const companyName = application.job.organization?.name;
    const title = decisionNotificationTitle(payload.status, jobTitle, companyName);
    return notificationRepo().create({
      userId: application.talentId,
      type: TALENT_NOTIFICATION.ApplicationUpdate,
      message: title,
      title,
      link: applicationLink(application.id),
    });
  });
  const CHUNK = 500;
  for (let i = 0; i < notifications.length; i += CHUNK) {
    await notificationRepo().save(notifications.slice(i, i + CHUNK));
  }

  return { updated: eligible.length, skipped: owned.length - eligible.length };
};
