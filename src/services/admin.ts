import { AppDataSource } from "../database/dataSource.js";
import { Job, Organization, User } from "../entities";
import { NotFoundError, ValidationError } from "../utils/errors";
import { JobStatus, OrganizationStatus, UserRole } from "../types/enums.js";
import { sortDirection } from "../utils/text.js";
import {
  purgeJobCascade,
  purgeOrganizationCascade,
  purgeRecruiterCascade,
  purgeTalentCascade,
} from "./cascadeDelete.js";
import { applyOnboardingFilters, OnboardingSummary, onboardingSummaries } from "./onboarding.js";
import { loadOrganizationMembers, OrganizationMemberView } from "./organization.js";

const userRepo = () => AppDataSource.getRepository(User);
const jobRepo = () => AppDataSource.getRepository(Job);
const orgRepo = () => AppDataSource.getRepository(Organization);

export interface AdminListParams {
  onboardingStage?: string;
  followUp?: string;
  search?: string;
  experience?: string;
  roleId?: string;
  status?: string;
  organizationId?: string;
  limit?: number | string;
  offset?: number | string;
  sort?: string;
}

type WithOnboarding = User & { onboarding: OnboardingSummary | null };

const withOnboarding = async (
  role: UserRole.Talent | UserRole.Recruiter,
  users: User[]
): Promise<WithOnboarding[]> => {
  const summaries = await onboardingSummaries(
    role,
    users.map((user) => user.id)
  );
  return users.map((user) => Object.assign(user, { onboarding: summaries.get(user.id) ?? null }));
};

export const listTalents = async (
  params: AdminListParams
): Promise<{ users: WithOnboarding[]; total: number }> => {
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
  applyOnboardingFilters(qb, UserRole.Talent, params);

  const [users, total] = await qb
    .orderBy("user.createdAt", order)
    .skip(offset)
    .take(limit)
    .getManyAndCount();

  return { users: await withOnboarding(UserRole.Talent, users), total };
};

export const deleteTalent = async (talentId: string): Promise<void> => {
  await AppDataSource.transaction(async (manager) => {
    await purgeTalentCascade(manager, talentId);
  });
};

export const listRecruiters = async (
  params: AdminListParams
): Promise<{ users: WithOnboarding[]; total: number }> => {
  const limit = Math.min(Number(params.limit) || 50, 200);
  const offset = Number(params.offset) || 0;
  const order = sortDirection(params.sort ?? "desc");

  const qb = userRepo()
    .createQueryBuilder("user")
    .where("user.userRole = :role", { role: UserRole.Recruiter });

  if (params.search?.trim()) {
    const term = `%${params.search.trim().toLowerCase()}%`;
    qb.andWhere(
      "(LOWER(user.firstName) LIKE :term OR LOWER(user.lastName) LIKE :term OR LOWER(user.email) LIKE :term)",
      { term }
    );
  }
  applyOnboardingFilters(qb, UserRole.Recruiter, params);

  const [users, total] = await qb
    .orderBy("user.createdAt", order)
    .skip(offset)
    .take(limit)
    .getManyAndCount();

  return { users: await withOnboarding(UserRole.Recruiter, users), total };
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
    .leftJoinAndSelect("job.postedBy", "postedBy")
    .leftJoinAndSelect("job.organization", "organization");

  if (params.search?.trim()) {
    const term = `%${params.search.trim().toLowerCase()}%`;
    qb.andWhere(
      "(LOWER(job.jobBrief) LIKE :term OR LOWER(role.name) LIKE :term OR LOWER(organization.name) LIKE :term OR LOWER(postedBy.email) LIKE :term OR LOWER(postedBy.firstName) LIKE :term OR LOWER(postedBy.lastName) LIKE :term)",
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
  if (params.organizationId) {
    qb.andWhere("job.organization_id = :organizationId", {
      organizationId: params.organizationId,
    });
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

export const listOrganizations = async (
  params: AdminListParams
): Promise<{ organizations: Organization[]; total: number }> => {
  const limit = Math.min(Number(params.limit) || 50, 200);
  const offset = Number(params.offset) || 0;
  const order = sortDirection(params.sort ?? "desc");

  const qb = orgRepo()
    .createQueryBuilder("organization")
    .leftJoinAndSelect("organization.owner", "owner");

  if (params.search?.trim()) {
    const term = `%${params.search.trim().toLowerCase()}%`;
    qb.andWhere(
      "(LOWER(organization.name) LIKE :term OR LOWER(organization.email) LIKE :term OR LOWER(organization.website) LIKE :term OR LOWER(owner.email) LIKE :term)",
      { term }
    );
  }
  if (params.status) {
    if (!Object.values(OrganizationStatus).includes(params.status as OrganizationStatus)) {
      throw new ValidationError("Invalid organization status filter");
    }
    qb.andWhere("organization.status = :status", { status: params.status });
  }

  const [organizations, total] = await qb
    .orderBy("organization.createdAt", order)
    .skip(offset)
    .take(limit)
    .getManyAndCount();

  return { organizations, total };
};

export type AdminOrganizationView = Organization & {
  members: OrganizationMemberView[];
};

export const getOrganization = async (organizationId: string): Promise<AdminOrganizationView> => {
  const org = await orgRepo().findOne({
    where: { id: organizationId },
    relations: { owner: true, verifiedBy: true },
  });
  if (!org) {
    throw new NotFoundError("Organization not found");
  }
  const members = await loadOrganizationMembers(organizationId);
  return Object.assign(org, { members });
};

export const deleteOrganizationAsAdmin = async (organizationId: string): Promise<void> => {
  await AppDataSource.transaction(async (manager) => {
    await purgeOrganizationCascade(manager, organizationId);
  });
};

export const updateOrganizationStatus = async (
  organizationId: string,
  adminId: string,
  status: OrganizationStatus.Verified | OrganizationStatus.Rejected
): Promise<Organization> => {
  const org = await orgRepo().findOne({ where: { id: organizationId } });
  if (!org) {
    throw new NotFoundError("Organization not found");
  }

  org.status = status;
  org.verifiedAt = new Date();
  org.verifiedById = adminId;

  return orgRepo().save(org);
};
