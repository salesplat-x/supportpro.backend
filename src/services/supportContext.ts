import { MoreThan } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { ErrorLog } from "../entities/ErrorLog.js";
import { Job } from "../entities/Job.js";
import { Organization } from "../entities/Organization.js";
import { OrganizationInvite, OrganizationInviteStatus } from "../entities/OrganizationInvite.js";
import { OrganizationMember } from "../entities/OrganizationMember.js";
import { User } from "../entities/User.js";
import { UserRole } from "../types/enums.js";
import { NotFoundError } from "../utils/errors";
import logger from "../utils/logger.js";
import { talentStuckApplications } from "./applicationFollowUps.js";
import { getOrganizationUsage } from "./entitlements.js";
import { getUserOnboarding } from "./onboarding.js";
import { getProfileCompletion, hasUploadedCv } from "./user.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const ERROR_WINDOW_MS = 14 * DAY_MS;
const RECENT_ERROR_LIMIT = 5;
const ERROR_MESSAGE_LIMIT = 200;

export interface SupportContext {
  account: {
    firstName: string;
    lastName: string;
    email: string;
    role: UserRole;
    country: string | null;
    signedUpAt: Date;
    daysSinceSignup: number;
    emailVerified: boolean;
    active: boolean;
  };
  onboarding: {
    stage: string;
    steps: Array<{ label: string; done: boolean }>;
    nextSteps: string[];
  } | null;
  talent: {
    profileCompletion: number;
    roles: string[];
    cvUploaded: boolean;
    cvUploadedAt: Date | null;
    prescreeningScore: number | null;
    assessmentRetryDate: Date | null;
    applicationsByStatus: Record<string, number>;
    stuckApplications: Array<{
      job: string;
      company: string | null;
      stage: string;
      daysStuck: number;
    }>;
  } | null;
  recruiter: {
    organization: {
      id: string;
      name: string;
      status: string;
      memberRole: string | null;
      teamSize: number;
      pendingInvites: number;
    } | null;
    plan: {
      billingPlan: string;
      billingStatus: string;
      billingPeriodEnd: Date | null;
      meters: Array<{ label: string; used: number; limit: number | null; period: string }>;
    } | null;
    jobsByStatus: Record<string, number>;
    totalApplicants: number;
  } | null;
  recentErrors: Array<{
    at: Date;
    errorType: string;
    method: string | null;
    endpoint: string | null;
    message: string;
  }> | null;
}

/** A section that fails comes back null, so one broken lookup never hides the rest. */
const section = async <T>(name: string, userId: string, build: () => Promise<T>) => {
  try {
    return await build();
  } catch (err) {
    logger.warn(
      `Support context "${name}" failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
};

const countsBy = (rows: Array<{ key: string; count: string | number }>) =>
  Object.fromEntries(rows.map((row) => [row.key, Number(row.count)]));

const onboardingSection = async (userId: string) => {
  const onboarding = await getUserOnboarding(userId);
  return {
    stage: onboarding.stage,
    steps: onboarding.steps.map((step) => ({ label: step.label, done: step.done })),
    nextSteps: onboarding.nextSteps?.steps ?? [],
  };
};

const talentSection = async (user: User) => {
  const applications = await AppDataSource.getRepository(Application)
    .createQueryBuilder("application")
    .select("application.status", "key")
    .addSelect("COUNT(*)", "count")
    .where("application.talentId = :userId", { userId: user.id })
    .groupBy("application.status")
    .getRawMany<{ key: string; count: string }>();
  const stuck = await talentStuckApplications(user.id);
  return {
    profileCompletion: getProfileCompletion(user).percentage,
    roles: (user.userRoles ?? []).map((role) => role.name),
    cvUploaded: hasUploadedCv(user),
    cvUploadedAt: user.cvUploadedAt,
    prescreeningScore: user.prescreeningScore,
    assessmentRetryDate: user.assessmentRetryDate,
    applicationsByStatus: countsBy(applications),
    stuckApplications: stuck.map((application) => ({
      job: application.job.title,
      company: application.company?.name ?? null,
      stage: application.stage,
      daysStuck: application.daysStuck,
    })),
  };
};

const planSection = async (organizationId: string) => {
  const usage = await getOrganizationUsage(organizationId);
  return {
    billingPlan: usage.billingPlan,
    billingStatus: usage.billingStatus,
    billingPeriodEnd: usage.billingPeriodEnd,
    meters: usage.meters.map((meter) => ({
      label: meter.label,
      used: meter.used,
      limit: meter.limit,
      period: meter.period,
    })),
  };
};

const organizationSection = async (user: User, organization: Organization) => {
  const memberRepo = AppDataSource.getRepository(OrganizationMember);
  const membership =
    organization.ownerId === user.id
      ? null
      : await memberRepo.findOne({
          where: { organizationId: organization.id, userId: user.id },
          select: { id: true, role: true },
        });
  return {
    id: organization.id,
    name: organization.name,
    status: organization.status,
    memberRole: organization.ownerId === user.id ? "owner" : (membership?.role ?? null),
    teamSize: await memberRepo.count({ where: { organizationId: organization.id } }),
    pendingInvites: await AppDataSource.getRepository(OrganizationInvite).count({
      where: { organizationId: organization.id, status: OrganizationInviteStatus.Pending },
    }),
  };
};

const recruiterSection = async (user: User) => {
  const organization = user.activeOrganizationId
    ? await AppDataSource.getRepository(Organization).findOne({
        where: { id: user.activeOrganizationId },
      })
    : null;
  const jobs = await AppDataSource.getRepository(Job)
    .createQueryBuilder("job")
    .select("job.status", "key")
    .addSelect("COUNT(*)", "count")
    .addSelect("COALESCE(SUM(job.noOfApplicants), 0)", "applicants")
    .where("job.postedById = :userId", { userId: user.id })
    .groupBy("job.status")
    .getRawMany<{ key: string; count: string; applicants: string }>();
  return {
    organization: organization
      ? await section("organization", user.id, () => organizationSection(user, organization))
      : null,
    plan: organization ? await section("plan", user.id, () => planSection(organization.id)) : null,
    jobsByStatus: countsBy(jobs),
    totalApplicants: jobs.reduce((sum, row) => sum + Number(row.applicants), 0),
  };
};

const recentErrorsSection = async (userId: string) => {
  const logs = await AppDataSource.getRepository(ErrorLog).find({
    where: { userId, timestamp: MoreThan(new Date(Date.now() - ERROR_WINDOW_MS)) },
    select: {
      id: true,
      timestamp: true,
      errorType: true,
      method: true,
      endpoint: true,
      message: true,
    },
    order: { timestamp: "DESC" },
    take: RECENT_ERROR_LIMIT,
  });
  return logs.map((log) => ({
    at: log.timestamp,
    errorType: log.errorType,
    method: log.method,
    endpoint: log.endpoint,
    message: log.message.slice(0, ERROR_MESSAGE_LIMIT),
  }));
};

/** What support needs to know about one user. The admin sees it, and the support AI reads a trimmed copy. */
export const buildSupportContext = async (userId: string): Promise<SupportContext> => {
  const user = await AppDataSource.getRepository(User).findOne({
    where: { id: userId },
    relations: { userRoles: true },
  });
  if (!user) {
    throw new NotFoundError("User not found");
  }

  return {
    account: {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.userRole,
      country: user.country,
      signedUpAt: user.createdAt,
      daysSinceSignup: Math.max(0, Math.floor((Date.now() - user.createdAt.getTime()) / DAY_MS)),
      emailVerified: !!user.emailVerifiedAt,
      active: user.active,
    },
    onboarding: await section("onboarding", userId, () => onboardingSection(userId)),
    talent:
      user.userRole === UserRole.Talent
        ? await section("talent", userId, () => talentSection(user))
        : null,
    recruiter:
      user.userRole === UserRole.Recruiter
        ? await section("recruiter", userId, () => recruiterSection(user))
        : null,
    recentErrors: await section("recentErrors", userId, () => recentErrorsSection(userId)),
  };
};
