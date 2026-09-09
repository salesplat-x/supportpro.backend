import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { Job } from "../entities/Job.js";
import { User } from "../entities/User.js";
import { NotFoundError, AuthorizationError } from "../utils/errors";
import { ApplicationType, ApplicationStatus, ScreeningStage } from "../types/enums.js";

const applicationRepo = () => AppDataSource.getRepository(Application);
const jobRepo = () => AppDataSource.getRepository(Job);
const userRepo = () => AppDataSource.getRepository(User);

export interface RecruiterDashboardResult {
  campaignCount: number;
  completedCampaigns: number;
  completionRatio: number;
  applicationsCount: number;
  shortlistCount: number;
  recentApplications: Array<{
    id: string;
    jobId: string;
    applicantName: string;
    prescreeningScore: number | null;
    cvSimilarityScore: number | null;
    dateApplied: Date;
  }>;
  recentCompilations: Array<{
    id: string;
    applicantName: string;
    mbtiType: string | null;
    prescreeningScore: number | null;
    cvSimilarityScore: number | null;
    personalizedScore: number | null;
    status: string;
    currentStage: string;
    jobId: string;
    role: string | null;
    dateApplied: Date;
  }>;
}

export const recruiterDashboard = async (
  recruiterId: string,
  jobId?: string
): Promise<RecruiterDashboardResult> => {
  const recruiter = await userRepo().findOne({ where: { id: recruiterId } });
  const activeOrgId = recruiter?.activeOrganizationId;

  // Total campaign / completion counts across recruiter OR active org
  let allApplications: Application[];
  if (activeOrgId) {
    allApplications = await applicationRepo()
      .createQueryBuilder("application")
      .leftJoin("application.job", "job")
      .where("(application.recruiter_id = :recruiterId OR job.organization_id = :activeOrgId)", {
        recruiterId,
        activeOrgId,
      })
      .getMany();
  } else {
    allApplications = await applicationRepo().find({
      where: { recruiterId },
    });
  }

  const campaignCount = allApplications.length;
  const completedCampaigns = allApplications.filter(
    (a) => a.currentStage === ScreeningStage.Completed
  ).length;
  const completionRatio =
    campaignCount === 0 ? 0 : Math.round((completedCampaigns / campaignCount) * 100);

  const applicationsCount = allApplications.filter(
    (a) => a.applicationType === ApplicationType.Application
  ).length;

  const shortlistCount = allApplications.filter(
    (a) => a.status === ApplicationStatus.Shortlisted
  ).length;

  // Recent applications (last 3 by application)
  const recentApplicationsQb = applicationRepo()
    .createQueryBuilder("application")
    .leftJoinAndSelect("application.talent", "talent")
    .leftJoin("application.job", "job")
    .andWhere("application.applicationType = :type", { type: ApplicationType.Application })
    .orderBy("application.createdAt", "DESC")
    .take(3);

  if (activeOrgId) {
    recentApplicationsQb.andWhere(
      "(application.recruiter_id = :recruiterId OR job.organization_id = :activeOrgId)",
      { recruiterId, activeOrgId }
    );
  } else {
    recentApplicationsQb.andWhere("application.recruiter_id = :recruiterId", { recruiterId });
  }

  const recentApplicationsRaw = await recentApplicationsQb.getMany();

  const recentApplications = recentApplicationsRaw.map((app) => ({
    id: app.id,
    jobId: app.jobId,
    applicantName: `${app.talent?.firstName ?? ""} ${app.talent?.lastName ?? ""}`.trim(),
    prescreeningScore: app.talent?.prescreeningScore ?? null,
    cvSimilarityScore: app.cvSimilarityScore,
    dateApplied: app.createdAt,
  }));

  // Recent compilations (last 4 by update)
  const compilationsQb = applicationRepo()
    .createQueryBuilder("application")
    .leftJoinAndSelect("application.talent", "talent")
    .leftJoinAndSelect("application.job", "job")
    .leftJoinAndSelect("job.role", "role");

  if (activeOrgId) {
    compilationsQb.where(
      "(application.recruiter_id = :recruiterId OR job.organization_id = :activeOrgId)",
      { recruiterId, activeOrgId }
    );
  } else {
    compilationsQb.where("application.recruiter_id = :recruiterId", { recruiterId });
  }

  if (jobId) {
    compilationsQb.andWhere("application.job_id = :jobId", { jobId });
  }

  const recentCompilationsRaw = await compilationsQb
    .orderBy("application.updatedAt", "DESC")
    .take(4)
    .getMany();

  const recentCompilations = recentCompilationsRaw.map((app) => ({
    id: app.id,
    applicantName: `${app.talent?.firstName ?? ""} ${app.talent?.lastName ?? ""}`.trim(),
    mbtiType: app.mbtiType,
    prescreeningScore: app.talent?.prescreeningScore ?? null,
    cvSimilarityScore: app.cvSimilarityScore,
    personalizedScore: app.personalizedScore,
    status: app.status,
    currentStage: app.currentStage,
    jobId: app.jobId,
    role: app.job?.role?.name ?? null,
    dateApplied: app.createdAt,
  }));

  return {
    campaignCount,
    completedCampaigns,
    completionRatio,
    applicationsCount,
    shortlistCount,
    recentApplications,
    recentCompilations,
  };
};

export interface RecruiterApplicationsParams {
  jobId?: string;
  applicationType?: ApplicationType;
  applicationStatus?: ApplicationStatus;
  offset?: number | string;
  limit?: number | string;
}

export const recruiterApplications = async (
  userId: string,
  payload: RecruiterApplicationsParams
): Promise<Application[]> => {
  const { jobId, applicationType, applicationStatus, offset, limit } = payload;
  const recruiter = await userRepo().findOne({ where: { id: userId } });
  const activeOrgId = recruiter?.activeOrganizationId;

  const qb = applicationRepo()
    .createQueryBuilder("application")
    .leftJoinAndSelect("application.talent", "talent")
    .leftJoinAndSelect("application.role", "role")
    .leftJoinAndSelect("application.job", "job")
    .leftJoinAndSelect("job.role", "jobRole");

  if (activeOrgId) {
    qb.where("(application.recruiter_id = :userId OR job.organization_id = :activeOrgId)", {
      userId,
      activeOrgId,
    });
  } else {
    qb.where("application.recruiter_id = :userId", { userId });
  }

  if (jobId) {
    const job = await jobRepo().findOne({ where: { id: jobId } });
    if (!job) {
      throw new NotFoundError("Job not found");
    }
    const isOrgMember = activeOrgId && job.organizationId === activeOrgId;
    if (job.postedById !== userId && !isOrgMember) {
      throw new AuthorizationError("You are not authorized to perform this action");
    }
    qb.andWhere("application.job_id = :jobId", { jobId });
  }

  if (applicationType) {
    qb.andWhere("application.applicationType = :applicationType", { applicationType });
    if (applicationType === ApplicationType.Application) {
      qb.orderBy("application.createdAt", "DESC");
    }
  }

  if (applicationStatus) {
    qb.andWhere("application.status = :applicationStatus", { applicationStatus });
  }

  const skip = Number(offset) || 0;
  const take = Number(limit) || 50;

  return qb.skip(skip).take(take).getMany();
};
