import { AppDataSource } from "../database/dataSource.js";
import { ScoutJob } from "../entities/ScoutJob.js";
import { Scout } from "../entities/Scout.js";
import { Role } from "../entities/Role.js";
import { NotFoundError, ValidationError } from "../utils/errors";
import { createEmbedding } from "../utils/integrations/openai.js";
import { preprocessText } from "../utils/text.js";
import { UserRole } from "../types/enums.js";
import {
  assertCompanyResourceAccess,
  getActiveOrganizationId,
  requireActiveOrganizationId,
} from "./organizationScope.js";

const scoutJobRepo = () => AppDataSource.getRepository(ScoutJob);

const roleRepo = () => AppDataSource.getRepository(Role);

export interface CreateScoutJobPayload {
  role: string;
  jobBrief: string;
  name: string;
  recruiterGuide: string;
}

export interface UpdateScoutJobPayload {
  id: string;
  role?: string;
  jobBrief?: string;
  name?: string;
  recruiterGuide?: string;
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

  // Create embedding for job description before persisting so the job is written
  // in a single insert — no separate write to leave the row in a half-built state.
  const jd = preprocessText(`${payload.jobBrief} \n ${payload.recruiterGuide}`);
  const embeddingResult = await createEmbedding(jd);
  if (!embeddingResult || !embeddingResult[0]?.embedding) {
    throw new ValidationError("Unable to create vector embedding for JD");
  }
  const jobEmbedding = `[${embeddingResult[0].embedding.toString()}]`;

  const scoutJob = scoutJobRepo().create({
    name: payload.name,
    jobBrief: payload.jobBrief,
    recruiterGuide: payload.recruiterGuide,
    roleId: payload.role,
    postedById: userId,
    organizationId,
    jobEmbedding,
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

  // FK from scouts to scout_jobs is ON DELETE NO ACTION, so dependent Scout
  // rows must be removed first, in one transaction, before the ScoutJob.
  await AppDataSource.transaction(async (manager) => {
    await manager.delete(Scout, { scoutJobId });
    await manager.delete(ScoutJob, { id: scoutJobId });
  });
};

export interface FetchScoutJobsParams {
  userId: string;
  limit?: number | string;
  offset?: number | string;
}

const MAX_PAGE_SIZE = 100;

export const fetchJobs = async (payload: FetchScoutJobsParams): Promise<ScoutJob[]> => {
  const activeOrgId = await getActiveOrganizationId(payload.userId);
  if (!activeOrgId) return [];

  const limit = Math.min(Number(payload.limit) || 20, MAX_PAGE_SIZE);
  const offset = Number(payload.offset) || 0;

  return scoutJobRepo().find({
    where: { organizationId: activeOrgId },
    relations: { role: true },
    order: { createdAt: "DESC" },
    take: limit,
    skip: offset,
  });
};
