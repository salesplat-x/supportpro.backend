import { In } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { Notification } from "../entities/Notification.js";
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
import { createNotification } from "./notification.js";
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

const notificationRepo = () => AppDataSource.getRepository(Notification);

const applicationRepo = () => AppDataSource.getRepository(Application);

const organizationRepo = () => AppDataSource.getRepository(Organization);

/**
 * Fields a candidate must never see on their own application: the scores the
 * recruiter uses to compare applicants (plan Day 5 — candidates aren't shown
 * their problem-solving or culture-fit result).
 */
export const CANDIDATE_HIDDEN_APPLICATION_FIELDS = [
  "problemSolvingScore",
  "cultureFitScore",
  "personalityFitScore",
  "personalityFitReason",
  "personalityFitLockedAt",
] as const;

export const hideAssessmentResultsFromCandidate = (application: Application): Application => {
  // The candidate may know a test is done (so the page can say so), never how it went.
  Object.assign(application, {
    problemSolvingSubmitted: application.problemSolvingScore != null,
    cultureFitSubmitted: application.cultureFitScore != null,
  });
  for (const field of CANDIDATE_HIDDEN_APPLICATION_FIELDS) {
    delete (application as Partial<Application>)[field];
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

  if (application.talentId === userId) {
    hideAssessmentResultsFromCandidate(application);
  } else {
    const [problemSolvingAnswers, cultureFitAnswers] = await Promise.all([
      buildGradedAnswerPairs(application.jobId, application.talentId, QuestionType.ProblemSolving),
      buildGradedAnswerPairs(application.jobId, application.talentId, QuestionType.CultureFit),
    ]);
    Object.assign(application, {
      problemSolvingAnswers,
      cultureFitAnswers,
      personalityFitPending: isPersonalityFitPending(application),
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
    void triggerMatchVerdict(application.talent, application);
  }

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
  if (userRole === UserRole.Talent) applications.forEach(hideAssessmentResultsFromCandidate);
  const recommendations = await loadRecommendationsByApplicationIds(applications.map((a) => a.id));
  return applications.map((application) =>
    overlayVerdictFromRecommendation(application, recommendations.get(application.id))
  );
};

export const updateStatus = async (
  userId: string,
  payload: { id: string; status: ApplicationStatus }
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
      await createNotification(application.talentId, title, title);
    } catch (err) {
      logger.error(
        `Decision notification failed for application ${application.id}: ${(err as Error).message}`
      );
    }
  }

  return saved;
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
): Promise<{ updated: number }> => {
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

  const changing = owned.filter((application) => application.status !== payload.status);

  for (const application of owned) {
    application.status = payload.status;
  }
  await applicationRepo().save(owned);

  const notifications = changing.map((application) => {
    const jobTitle = application.job.role?.name;
    const companyName = application.job.organization?.name;
    const title = decisionNotificationTitle(payload.status, jobTitle, companyName);
    return notificationRepo().create({
      userId: application.talentId,
      message: title,
      title,
    });
  });
  const CHUNK = 500;
  for (let i = 0; i < notifications.length; i += CHUNK) {
    await notificationRepo().save(notifications.slice(i, i + CHUNK));
  }

  return { updated: owned.length };
};
