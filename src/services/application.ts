import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { Scout } from "../entities/Scout.js";
import { NotFoundError, AuthorizationError } from "../utils/errors/index.js";
import { UserRole, ApplicationType, ApplicationStatus, ScreeningStage } from "../types/enums.js";
import { sortDirection } from "../utils/text.js";

const applicationRepo = () => AppDataSource.getRepository(Application);

const scoutRepo = () => AppDataSource.getRepository(Scout);

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

  return qb.skip(offset).take(limit).getMany();
};

export const shortlist = async (
  userId: string,
  payload: FetchApplicationsParams
): Promise<{ campaigns: Application[]; scouts: Scout[] }> => {
  const limit = Math.min(Number(payload.limit) || 50, MAX_PAGE_SIZE);
  const offset = Number(payload.offset) || 0;
  const order = sortDirection(payload.sort ?? "desc");

  const [campaigns, scouts] = await Promise.all([
    applicationRepo().find({
      where: { recruiterId: userId },
      relations: { talent: true, job: { role: true } },
      skip: offset,
      take: limit,
      order: { updatedAt: order },
    }),
    scoutRepo().find({
      where: { recruiterId: userId },
      select: {
        id: true,
        cvName: true,
        evaluationScore: true,
      },
      skip: offset,
      take: limit,
      order: { updatedAt: order },
    }),
  ]);

  return { campaigns, scouts };
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
