import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { NotFoundError, AuthorizationError } from "../utils/errors/index.js";
import { UserRole, ApplicationType, ApplicationStatus, ScreeningStage } from "../types/enums.js";

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
  return applicationRepo().save(application);
};
