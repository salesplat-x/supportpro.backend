import { AppDataSource } from "../database/dataSource.js";
import { Job, User } from "../entities";
import { ValidationError } from "../utils/errors";
import { JobStatus, UserRole } from "../types/enums.js";
import { sortDirection } from "../utils/text.js";
import { purgeJobCascade, purgeRecruiterCascade, purgeTalentCascade } from "./cascadeDelete.js";

const userRepo = () => AppDataSource.getRepository(User);
const jobRepo = () => AppDataSource.getRepository(Job);

export interface AdminListParams {
  search?: string;
  experience?: string;
  roleId?: string;
  status?: string;
  limit?: number | string;
  offset?: number | string;
  sort?: string;
}

export const listTalents = async (
  params: AdminListParams
): Promise<{ users: User[]; total: number }> => {
  const limit = Math.min(Number(params.limit) || 50, 200);
  const offset = Number(params.offset) || 0;
  const order = sortDirection(params.sort ?? "desc");

  const qb = userRepo()
    .createQueryBuilder("user")
    .leftJoinAndSelect("user.userRoles", "userRoles")
    .where("user.userRole = :role", { role: UserRole.Talent });

  if (params.search?.trim()) {
    const term = `%${params.search.trim().toLowerCase()}%`;
    qb.andWhere(
      "(LOWER(user.firstName) LIKE :term OR LOWER(user.lastName) LIKE :term OR LOWER(user.email) LIKE :term)",
      { term }
    );
  }
  if (params.experience) {
    qb.andWhere("user.experience = :experience", { experience: params.experience });
  }
  if (params.roleId) {
    qb.andWhere("userRoles.id = :roleId", { roleId: params.roleId });
  }

  const [users, total] = await qb
    .orderBy("user.createdAt", order)
    .skip(offset)
    .take(limit)
    .getManyAndCount();

  return { users, total };
};

export const deleteTalent = async (talentId: string): Promise<void> => {
  await AppDataSource.transaction(async (manager) => {
    await purgeTalentCascade(manager, talentId);
  });
};

export const listRecruiters = async (
  params: AdminListParams
): Promise<{ users: User[]; total: number }> => {
  const limit = Math.min(Number(params.limit) || 50, 200);
  const offset = Number(params.offset) || 0;
  const order = sortDirection(params.sort ?? "desc");

  const qb = userRepo()
    .createQueryBuilder("user")
    .leftJoinAndSelect("user.organization", "organization")
    .where("user.userRole = :role", { role: UserRole.Recruiter });

  if (params.search?.trim()) {
    const term = `%${params.search.trim().toLowerCase()}%`;
    qb.andWhere(
      "(LOWER(user.firstName) LIKE :term OR LOWER(user.lastName) LIKE :term OR LOWER(user.email) LIKE :term OR LOWER(organization.name) LIKE :term)",
      { term }
    );
  }

  const [users, total] = await qb
    .orderBy("user.createdAt", order)
    .skip(offset)
    .take(limit)
    .getManyAndCount();

  return { users, total };
};

export const deleteRecruiter = async (recruiterId: string): Promise<void> => {
  await AppDataSource.transaction(async (manager) => {
    await purgeRecruiterCascade(manager, recruiterId);
  });
};

export const listJobs = async (
  params: AdminListParams
): Promise<{ jobs: Job[]; total: number }> => {
  const limit = Math.min(Number(params.limit) || 50, 200);
  const offset = Number(params.offset) || 0;
  const order = sortDirection(params.sort ?? "desc");

  const qb = jobRepo()
    .createQueryBuilder("job")
    .leftJoinAndSelect("job.role", "role")
    .leftJoinAndSelect("job.postedBy", "postedBy");

  if (params.search?.trim()) {
    const term = `%${params.search.trim().toLowerCase()}%`;
    qb.andWhere(
      "(LOWER(job.jobBrief) LIKE :term OR LOWER(role.name) LIKE :term OR LOWER(postedBy.email) LIKE :term OR LOWER(postedBy.firstName) LIKE :term OR LOWER(postedBy.lastName) LIKE :term)",
      { term }
    );
  }
  if (params.status) {
    if (!Object.values(JobStatus).includes(params.status as JobStatus)) {
      throw new ValidationError("Invalid job status filter");
    }
    qb.andWhere("job.status = :status", { status: params.status });
  }
  if (params.roleId) {
    qb.andWhere("job.role_id = :roleId", { roleId: params.roleId });
  }

  const [jobs, total] = await qb
    .orderBy("job.createdAt", order)
    .skip(offset)
    .take(limit)
    .getManyAndCount();

  return { jobs, total };
};

export const deleteJobAsAdmin = async (jobId: string): Promise<void> => {
  await AppDataSource.transaction(async (manager) => {
    await purgeJobCascade(manager, jobId);
  });
};
