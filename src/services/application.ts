import { In } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { Notification } from "../entities/Notification.js";
import { NotFoundError, AuthorizationError, ValidationError } from "../utils/errors";
import { UserRole, ApplicationType, ApplicationStatus, ScreeningStage } from "../types/enums.js";
import { createNotification } from "./notification.js";
import { decisionNotificationMessage } from "./applicationNotifications.js";
import { triggerMatchVerdict } from "./applicationStage.js";
import logger from "../utils/logger.js";

const notificationRepo = () => AppDataSource.getRepository(Notification);

const applicationRepo = () => AppDataSource.getRepository(Application);

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
  applicationId: string
): Promise<{ application: Application; count: number }> => {
  const application = await applicationRepo().findOne({
    where: { id: applicationId },
    relations: { job: { postedBy: true }, talent: true, role: true },
  });

  if (!application) {
    throw new NotFoundError("Application not found");
  }

  if (application.job.postedById !== userId && application.talentId !== userId) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }

  const count = await applicationRepo().count({
    where: {
      currentStage: ScreeningStage.Completed,
      jobId: application.jobId,
    },
  });

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
    qb.where("application.recruiter_id = :userId", { userId });
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

  return qb.skip(offset).take(limit).getMany();
};

export const updateStatus = async (
  userId: string,
  payload: { id: string; status: ApplicationStatus }
): Promise<Application> => {
  const application = await applicationRepo().findOne({
    where: { id: payload.id },
    relations: { job: true, talent: true },
  });

  if (!application) {
    throw new NotFoundError("Application not found");
  }

  if (application.job.postedById !== userId && application.talentId !== userId) {
    throw new AuthorizationError("You are not authorized to perform this action");
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
      await createNotification(application.talentId, decisionNotificationMessage(payload.status));
    } catch (err) {
      logger.error(
        `Decision notification failed for application ${application.id}: ${(err as Error).message}`
      );
    }
  }

  return saved;
};

// Manual retry path for the AI match verdict — the automatic trigger only ever
// fires once, fire-and-forget, the moment an application completes; if that
// single attempt fails (a bad LLM response, a transient API error) there was
// previously no way to get a verdict for that applicant ever again. This is
// awaited (not fire-and-forget) so the caller gets a real result or error.
export const regenerateVerdict = async (
  userId: string,
  applicationId: string
): Promise<Application> => {
  const application = await applicationRepo().findOne({
    where: { id: applicationId },
    relations: { job: true, talent: true },
  });

  if (!application) {
    throw new NotFoundError("Application not found");
  }

  if (application.job.postedById !== userId) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }

  if (application.currentStage !== ScreeningStage.Completed) {
    throw new ValidationError(
      "This application hasn't completed its screening pipeline yet — a match verdict isn't available until it has"
    );
  }

  await triggerMatchVerdict(application.talent, application);

  // triggerMatchVerdict swallows its own errors (by design — the automatic,
  // fire-and-forget call site must never let a verdict failure bubble up to the
  // talent). Here, the caller *is* waiting on a real result, so surface failure
  // by checking whether a verdict actually got persisted.
  const refreshed = await applicationRepo().findOne({ where: { id: applicationId } });
  if (!refreshed) {
    throw new NotFoundError("Application not found");
  }
  if (!refreshed.matchVerdict) {
    throw new ValidationError(
      "Could not generate a match verdict right now — please try again shortly"
    );
  }
  return refreshed;
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
  const applications = await applicationRepo().find({
    where: { id: In(payload.applicationIds) },
    relations: { job: true },
  });

  const owned = applications.filter((application) => application.job.postedById === userId);
  if (owned.length === 0) {
    throw new NotFoundError("No applications found");
  }

  for (const application of owned) {
    application.status = payload.status;
  }
  await applicationRepo().save(owned);

  const message = decisionNotificationMessage(payload.status);
  const notifications = owned.map((application) =>
    notificationRepo().create({ userId: application.talentId, message })
  );
  const CHUNK = 500;
  for (let i = 0; i < notifications.length; i += CHUNK) {
    await notificationRepo().save(notifications.slice(i, i + CHUNK));
  }

  return { updated: owned.length };
};
