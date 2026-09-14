import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { Job } from "../entities/Job.js";
import { NotFoundError, AuthorizationError } from "../utils/errors";
import { ApplicationType, ApplicationStatus, ScreeningStage } from "../types/enums.js";
import { getActiveOrganizationId } from "./organizationScope.js";

const applicationRepo = () => AppDataSource.getRepository(Application);
const jobRepo = () => AppDataSource.getRepository(Job);

export interface RecruiterDashboardResult {
  campaignCount: number;
  completedCampaigns: number;
  completionRatio: number;
  applicationsCount: number;
  shortlistCount: number;
  applicationHeatmap: Array<{ date: string; count: number }>;
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

const EMPTY_DASHBOARD: RecruiterDashboardResult = {
  campaignCount: 0,
  completedCampaigns: 0,
  completionRatio: 0,
  applicationsCount: 0,
  shortlistCount: 0,
  applicationHeatmap: [],
  recentApplications: [],
  recentCompilations: [],
};

export const recruiterDashboard = async (
  recruiterId: string,
  jobId?: string
): Promise<RecruiterDashboardResult> => {
  const activeOrgId = await getActiveOrganizationId(recruiterId);
  if (!activeOrgId) return EMPTY_DASHBOARD;

  const allApplications = await applicationRepo()
    .createQueryBuilder("application")
    .leftJoin("application.job", "job")
    .where("job.organization_id = :activeOrgId", { activeOrgId })
    .getMany();

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

  const heatmapSince = new Date();
  heatmapSince.setUTCDate(heatmapSince.getUTCDate() - 83);
  heatmapSince.setUTCHours(0, 0, 0, 0);

  const heatmapRows: Array<{ date: string; count: string | number }> = await applicationRepo()
    .createQueryBuilder("application")
    .leftJoin("application.job", "job")
    .select("TO_CHAR(application.createdAt, 'YYYY-MM-DD')", "date")
    .addSelect("COUNT(application.id)", "count")
    .where("job.organization_id = :activeOrgId", { activeOrgId })
    .andWhere("application.createdAt >= :heatmapSince", { heatmapSince })
    .groupBy("TO_CHAR(application.createdAt, 'YYYY-MM-DD')")
    .getRawMany();

  const applicationHeatmap = heatmapRows.map((row) => ({
    date: row.date,
    count: Number(row.count) || 0,
  }));

  const recentApplicationsRaw = await applicationRepo()
    .createQueryBuilder("application")
    .leftJoinAndSelect("application.talent", "talent")
    .leftJoin("application.job", "job")
    .where("job.organization_id = :activeOrgId", { activeOrgId })
    .andWhere("application.applicationType = :type", { type: ApplicationType.Application })
    .orderBy("application.createdAt", "DESC")
    .take(3)
    .getMany();

  const recentApplications = recentApplicationsRaw.map((app) => ({
    id: app.id,
    jobId: app.jobId,
    applicantName: `${app.talent?.firstName ?? ""} ${app.talent?.lastName ?? ""}`.trim(),
    prescreeningScore: app.talent?.prescreeningScore ?? null,
    cvSimilarityScore: app.cvSimilarityScore,
    dateApplied: app.createdAt,
  }));

  const compilationsQb = applicationRepo()
    .createQueryBuilder("application")
    .leftJoinAndSelect("application.talent", "talent")
    .leftJoinAndSelect("application.job", "job")
    .leftJoinAndSelect("job.role", "role")
    .where("job.organization_id = :activeOrgId", { activeOrgId });

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
    applicationHeatmap,
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
  const activeOrgId = await getActiveOrganizationId(userId);
  if (!activeOrgId) return [];

  const qb = applicationRepo()
    .createQueryBuilder("application")
    .leftJoinAndSelect("application.talent", "talent")
    .leftJoinAndSelect("application.role", "role")
    .leftJoinAndSelect("application.job", "job")
    .leftJoinAndSelect("job.role", "jobRole")
    .where("job.organization_id = :activeOrgId", { activeOrgId });

  if (jobId) {
    const job = await jobRepo().findOne({ where: { id: jobId } });
    if (!job) {
      throw new NotFoundError("Job not found");
    }
    if (job.organizationId !== activeOrgId) {
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
