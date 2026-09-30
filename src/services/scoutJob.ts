import { AppDataSource } from "../database/dataSource.js";
import { ScoutJob } from "../entities/ScoutJob.js";
import { Scout } from "../entities/Scout.js";
import { ScoutRun } from "../entities/ScoutRun.js";
import { Role } from "../entities/Role.js";
import { NotFoundError } from "../utils/errors";
import { ExperienceLevel, UserRole, WorkMode } from "../types/enums.js";
import { DEFAULT_SHORTLIST_SIZE } from "../config/scout.js";
import {
  assertCompanyResourceAccess,
  getActiveOrganizationId,
  requireActiveOrganizationId,
} from "./organizationScope.js";

const scoutJobRepo = () => AppDataSource.getRepository(ScoutJob);

const roleRepo = () => AppDataSource.getRepository(Role);

export interface ScoutJobTargeting {
  experienceLevel?: ExperienceLevel | null;
  mustHaveSkills?: string[] | null;
  niceToHaveSkills?: string[] | null;
  workMode?: WorkMode | null;
  locationCountry?: string | null;
  locationState?: string | null;
  locationCity?: string | null;
}

export interface CreateScoutJobPayload extends ScoutJobTargeting {
  role: string;
  jobBrief: string;
  name: string;
  recruiterGuide: string;
  shortlistSize?: number;
}

export interface UpdateScoutJobPayload extends ScoutJobTargeting {
  id: string;
  role?: string;
  jobBrief?: string;
  name?: string;
  recruiterGuide?: string;
  shortlistSize?: number;
}

/** Per-campaign rollup shown on the campaign list, so a row carries real signal. */
export interface ScoutJobWithStats extends ScoutJob {
  runCount: number;
  cvsScanned: number;
  bestScore: number | null;
  lastActivityAt: Date | null;
}

export const createJob = async (
  userId: string,
  payload: CreateScoutJobPayload
): Promise<ScoutJob> => {
  const organizationId = await requireActiveOrganizationId(
    userId,
    "Create or switch to a company before scouting"
  );

  const existingRole = await roleRepo().findOne({ where: { id: payload.role } });
  if (!existingRole) {
    throw new NotFoundError("Role does not exist");
  }

  const scoutJob = scoutJobRepo().create({
    name: payload.name,
    jobBrief: payload.jobBrief,
    recruiterGuide: payload.recruiterGuide,
    roleId: payload.role,
    postedById: userId,
    organizationId,
    shortlistSize: payload.shortlistSize ?? DEFAULT_SHORTLIST_SIZE,
    experienceLevel: payload.experienceLevel ?? null,
    mustHaveSkills: payload.mustHaveSkills ?? null,
    niceToHaveSkills: payload.niceToHaveSkills ?? null,
    workMode: payload.workMode ?? null,
    locationCountry: payload.locationCountry ?? null,
    locationState: payload.locationState ?? null,
    locationCity: payload.locationCity ?? null,
  });

  return scoutJobRepo().save(scoutJob);
};

export const updateJob = async (
  userId: string,
  payload: UpdateScoutJobPayload
): Promise<ScoutJob> => {
  const { id, role, ...update } = payload;

  const existingJob = await scoutJobRepo().findOne({
    where: { id },
    relations: { postedBy: true },
  });
  if (!existingJob) {
    throw new NotFoundError("Job does not exist");
  }

  await assertCompanyResourceAccess(
    userId,
    UserRole.Recruiter,
    existingJob.organizationId,
    existingJob.postedById
  );

  if (role) {
    const existingRole = await roleRepo().findOne({ where: { id: role } });
    if (!existingRole) {
      throw new NotFoundError("Role does not exist");
    }
  }

  const updated = await scoutJobRepo().save({
    ...existingJob,
    ...update,
    ...(role ? { roleId: role } : {}),
  });
  return updated;
};

export const fetchJob = async (
  scoutJobId: string,
  userId: string,
  isAdmin: boolean
): Promise<ScoutJob> => {
  const scoutJob = await scoutJobRepo().findOne({
    where: { id: scoutJobId },
    relations: { role: true, postedBy: true },
  });
  if (!scoutJob) {
    throw new NotFoundError("Job not found");
  }
  await assertCompanyResourceAccess(
    userId,
    isAdmin ? UserRole.Admin : UserRole.Recruiter,
    scoutJob.organizationId,
    scoutJob.postedById
  );
  return scoutJob;
};

export const deleteJob = async (userId: string, scoutJobId: string): Promise<void> => {
  const existingJob = await scoutJobRepo().findOne({ where: { id: scoutJobId } });
  if (!existingJob) {
    throw new NotFoundError("Job does not exist");
  }
  await assertCompanyResourceAccess(
    userId,
    UserRole.Recruiter,
    existingJob.organizationId,
    existingJob.postedById
  );

  // The FK from scouts to scout_jobs is ON DELETE NO ACTION, so dependent Scout
  // rows must go first. scout_runs cascades from scout_jobs, but its own scouts
  // are removed here anyway, in one transaction, before the ScoutJob.
  await AppDataSource.transaction(async (manager) => {
    await manager.delete(Scout, { scoutJobId });
    await manager.delete(ScoutRun, { scoutJobId });
    await manager.delete(ScoutJob, { id: scoutJobId });
  });
};

export interface FetchScoutJobsParams {
  userId: string;
  limit?: number | string;
  offset?: number | string;
  search?: string;
}

const MAX_PAGE_SIZE = 100;

export interface FetchScoutJobsResult {
  scoutJobs: ScoutJobWithStats[];
  total: number;
}

export const fetchJobs = async (payload: FetchScoutJobsParams): Promise<FetchScoutJobsResult> => {
  const activeOrgId = await getActiveOrganizationId(payload.userId);
  if (!activeOrgId) return { scoutJobs: [], total: 0 };

  const limit = Math.min(Number(payload.limit) || 20, MAX_PAGE_SIZE);
  const offset = Number(payload.offset) || 0;

  const qb = scoutJobRepo()
    .createQueryBuilder("scoutJob")
    .leftJoinAndSelect("scoutJob.role", "role")
    .where("scoutJob.organization_id = :activeOrgId", { activeOrgId });

  if (payload.search?.trim()) {
    qb.andWhere("(scoutJob.name ILIKE :search OR role.name ILIKE :search)", {
      search: `%${payload.search.trim()}%`,
    });
  }

  const [scoutJobs, total] = await qb
    .orderBy("scoutJob.createdAt", "DESC")
    .take(limit)
    .skip(offset)
    .getManyAndCount();

  if (scoutJobs.length === 0) return { scoutJobs: [], total };

  return { scoutJobs: await attachStats(scoutJobs), total };
};

/**
 * One grouped query for the whole page rather than four per row, so the list stays
 * cheap as a workspace accumulates campaigns.
 */
const attachStats = async (scoutJobs: ScoutJob[]): Promise<ScoutJobWithStats[]> => {
  const ids = scoutJobs.map((job) => job.id);

  const rows: Array<{
    scout_job_id: string;
    cvs_scanned: string;
    best_score: number | null;
    last_activity_at: Date | null;
  }> = await AppDataSource.query(
    `SELECT scout_job_id,
            COUNT(*)::text AS cvs_scanned,
            MAX("evaluationScore") AS best_score,
            MAX("createdAt") AS last_activity_at
       FROM scouts
      WHERE scout_job_id = ANY($1)
      GROUP BY scout_job_id`,
    [ids]
  );

  const runRows: Array<{ scout_job_id: string; run_count: string }> = await AppDataSource.query(
    `SELECT scout_job_id, COUNT(*)::text AS run_count
       FROM scout_runs
      WHERE scout_job_id = ANY($1)
      GROUP BY scout_job_id`,
    [ids]
  );

  const statsById = new Map(rows.map((row) => [row.scout_job_id, row]));
  const runsById = new Map(runRows.map((row) => [row.scout_job_id, Number(row.run_count)]));

  return scoutJobs.map((job) => {
    const stats = statsById.get(job.id);
    return Object.assign(job, {
      runCount: runsById.get(job.id) ?? 0,
      cvsScanned: stats ? Number(stats.cvs_scanned) : 0,
      bestScore: stats?.best_score ?? null,
      lastActivityAt: stats?.last_activity_at ?? null,
    });
  });
};
