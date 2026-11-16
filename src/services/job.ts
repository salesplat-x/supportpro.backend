import { In, IsNull, Not } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import logger from "../utils/logger.js";
import { Job } from "../entities/Job.js";
import { Role } from "../entities/Role.js";
import { AIConfig } from "../entities/AIConfig.js";
import { Application } from "../entities/Application.js";
import { User } from "../entities/User.js";
import { Organization } from "../entities/Organization.js";
import { Notification } from "../entities/Notification.js";
import { Scout } from "../entities/Scout.js";
import { NotFoundError, AuthorizationError, ValidationError } from "../utils/errors";
import { purgeJobCascade } from "./cascadeDelete.js";
import { assertCompanyResourceAccess, getActiveOrganizationId } from "./organizationScope.js";
import { countActiveJobs, ensureOrganizationBillingCurrent, isAtLimit } from "./entitlements.js";
import {
  UserRole,
  JobStatus,
  WorkMode,
  ApplicationType,
  ApplicationStatus,
  ScreeningStage,
  CompensationPeriod,
  Currency,
  EmploymentType,
  ExperienceLevel,
  MatchVerdict,
  MatchVerdictStatus,
  DEFAULT_BILLING_PLAN_KEY,
} from "../types/enums.js";
import {
  createEmbedding,
  generateJobContent as generateJobContentAI,
  generateJobField as generateJobFieldAI,
  GenerateJobFieldContext,
  assessTalentFit,
} from "../utils/integrations/openai.js";
import { TalentEmbedding } from "../entities/TalentEmbedding.js";
import {
  convertSimilarityToPercentage,
  escapeLike,
  extractText,
  preprocessText,
  sortDirection,
} from "../utils/text.js";
import { workModeNeedsLocation } from "../utils/workMode.js";
import { resultRows } from "../utils/durableJobs.js";
import { createStages } from "./aiConfig.js";
import {
  computeCvSimilarityScore,
  rescoreCvSimilarity,
  syncCandidateStage,
  loadRecommendationsByApplicationIds,
  overlayVerdictFromRecommendation,
  triggerMatchVerdict,
  resetMatchVerdictRetry,
} from "./applicationStage.js";
import { startAiInterviewIfReached } from "./aiInterview.js";
import {
  type ApplicationProgress,
  type BoardColumn,
  type InterviewProgress,
  boardColumnSql,
  interviewProgressSql,
  loadApplicationProgress,
  NO_PROGRESS,
} from "./applicationProgress.js";
import { AiInterview } from "../entities/AiInterview.js";
import { regenerateCvEmbedding } from "./user.js";
import { screeningPlan, type ScreeningPlanStep } from "./screeningPlan.js";
import { savedJobIds } from "./savedJobs.js";

const jobRepo = () => AppDataSource.getRepository(Job);

const roleRepo = () => AppDataSource.getRepository(Role);

const MAX_PAGE_SIZE = 100;

const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/**
 * GET /jobs and GET /jobs/:_id are optionalAuth, so everything they return is
 * readable by anonymous visitors on the public job page — including social
 * crawlers. The Organization, User and AIConfig relations are loaded whole by
 * TypeORM, which would otherwise publish company contact details and billing
 * state, the recruiter's email and CV fields, and the job's screening
 * thresholds and uploaded assessment questions. Only the fields the job page
 * actually renders survive the trip out.
 */
export type PublicJobOrganization = {
  id: string;
  name: string;
  logoUrl: string | null;
  website: string | null;
};

export type PublicJobPoster = {
  id: string;
  firstName: string;
  lastName: string;
};

export type PublicJobAiConfig = {
  id: string;
};

const toPublicOrganization = (organization?: Organization | null): PublicJobOrganization | null => {
  if (!organization) return null;
  return {
    id: organization.id,
    name: organization.name,
    logoUrl: organization.logoUrl,
    website: organization.website,
  };
};

const toPublicPoster = (poster?: User | null): PublicJobPoster | null => {
  if (!poster) return null;
  return {
    id: poster.id,
    firstName: poster.firstName,
    lastName: poster.lastName,
  };
};

const toPublicAiConfig = (aiConfig?: AIConfig | null): PublicJobAiConfig | null => {
  if (!aiConfig) return null;
  return { id: aiConfig.id };
};

/**
 * noOfApplicants is hiring-team data: talents and anonymous visitors never
 * receive it, so it is only added back when the caller opts in.
 */
export type PublicJob = Omit<Job, "organization" | "postedBy" | "aiConfig" | "noOfApplicants"> & {
  noOfApplicants?: number;
  organization: PublicJobOrganization | null;
  postedBy: PublicJobPoster | null;
  aiConfig: PublicJobAiConfig | null;
};

type PublicJobOptions = { includeApplicantCount?: boolean };

const toPublicJob = (job: Job, options: PublicJobOptions = {}): PublicJob => {
  const { noOfApplicants, ...rest } = job;
  return {
    ...rest,
    ...(options.includeApplicantCount ? { noOfApplicants } : {}),
    organization: toPublicOrganization(job.organization),
    postedBy: toPublicPoster(job.postedBy),
    aiConfig: toPublicAiConfig(job.aiConfig),
  };
};

export type JobViewer = { id: string; role: UserRole };

const canSeeApplicantCount = async (job: Job, viewer?: JobViewer): Promise<boolean> => {
  if (!viewer) return false;
  if (viewer.role === UserRole.Admin) return true;
  if (viewer.role !== UserRole.Recruiter) return false;
  if (job.postedById === viewer.id) return true;
  if (!job.organizationId) return false;
  return (await getActiveOrganizationId(viewer.id)) === job.organizationId;
};

const aiConfigRepo = () => AppDataSource.getRepository(AIConfig);

const applicationRepo = () => AppDataSource.getRepository(Application);

const userRepo = () => AppDataSource.getRepository(User);

const notificationRepo = () => AppDataSource.getRepository(Notification);

const talentEmbeddingRepo = () => AppDataSource.getRepository(TalentEmbedding);

const scoutRepo = () => AppDataSource.getRepository(Scout);

const organizationRepo = () => AppDataSource.getRepository(Organization);

const locationFieldsForWorkMode = (payload: {
  workMode: string[];
  locationCountry?: string | null;
  locationState?: string | null;
  locationCity?: string | null;
}) => {
  if (!workModeNeedsLocation(payload.workMode)) {
    return {
      locationCountry: null as string | null,
      locationState: null as string | null,
      locationCity: null as string | null,
    };
  }

  const locationCountry = payload.locationCountry?.trim() || null;
  if (!locationCountry) {
    throw new ValidationError("locationCountry is required for hybrid or on-site jobs");
  }

  return {
    locationCountry,
    locationState: payload.locationState ?? null,
    locationCity: payload.locationCity ?? null,
  };
};

export const assertRecruiterJobAccess = async (
  userId: string,
  userRole: UserRole,
  job: Job
): Promise<void> => {
  await assertCompanyResourceAccess(userId, userRole, job.organizationId, job.postedById);
};

export interface CreateJobPayload {
  role?: string;
  aiConfigId?: string | null;
  jobBrief: string;
  maxSalary?: number | null;
  minSalary: number;
  compensationPeriod: CompensationPeriod;
  experienceLevel: string;
  locationCity?: string | null;
  locationState?: string | null;
  locationCountry?: string | null;
  workMode: string[];
  currency?: string | null;
  requirements?: string | null;
  skills?: string[] | null;
  goals?: string[] | null;
  department?: string | null;
  employmentType?: EmploymentType;
  closesAt?: string | null;
  shareOptions?: boolean;
}

export interface UpdateJobPayload extends Partial<CreateJobPayload> {
  id: string;
  status?: JobStatus;
}

type EditableJobField = Exclude<keyof CreateJobPayload, "role">;

/**
 * Request bodies are not stripped by validation, so only these fields may be copied onto a
 * job. Status, ownership and organization are server-owned: a client-supplied status would
 * skip payment and plan limits, and a client-supplied organizationId would move the job.
 */
const EDITABLE_JOB_FIELDS: readonly EditableJobField[] = [
  "aiConfigId",
  "jobBrief",
  "maxSalary",
  "minSalary",
  "compensationPeriod",
  "experienceLevel",
  "locationCity",
  "locationState",
  "locationCountry",
  "workMode",
  "currency",
  "requirements",
  "skills",
  "goals",
  "department",
  "employmentType",
  "closesAt",
  "shareOptions",
];

const pickEditableJobFields = (
  payload: Partial<CreateJobPayload>
): Partial<Pick<CreateJobPayload, EditableJobField>> => {
  const picked: Partial<Record<EditableJobField, unknown>> = {};
  for (const field of EDITABLE_JOB_FIELDS) {
    if (payload[field] !== undefined) picked[field] = payload[field];
  }
  if (picked.department === "") picked.department = null;
  return picked as Partial<Pick<CreateJobPayload, EditableJobField>>;
};

export interface FetchJobsParams {
  roleId?: string;
  status?: string;
  employmentType?: string;
  experienceLevel?: string;
  postedBy?: string;
  organizationId?: string;
  city?: string;
  state?: string;
  country?: string;
  workMode?: string;
  q?: string;
  minMonthlySalary?: number | string;
  currency?: string;
  postedWithin?: string;
  limit?: number | string;
  offset?: number | string;
  sort?: string;
  talentId?: string;
}

export interface TopTalentsParams {
  jobId: string;
  limit?: number;
  percentage?: number;
}

export interface MatchJobParams {
  id: string;
  incomplete?: string;
}

export const createJob = async (userId: string, payload: CreateJobPayload): Promise<Job> => {
  const user = await userRepo().findOne({ where: { id: userId } });
  if (!user?.activeOrganizationId) {
    throw new ValidationError("Create or switch to a company before posting a job");
  }
  const organizationId = user.activeOrganizationId;

  let roleId: string;

  if (payload.role) {
    // Only attempt ID lookup if the value looks like a UUID (avoids PostgreSQL type errors)
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      payload.role
    );
    const roleById = isUUID ? await roleRepo().findOne({ where: { id: payload.role } }) : null;
    if (roleById) {
      roleId = roleById.id;
    } else {
      // role is a name string, find or create
      const roleName = payload.role.toLowerCase();
      let existingRole = await roleRepo().findOne({ where: { name: roleName } });
      if (!existingRole) {
        existingRole = await roleRepo().save(roleRepo().create({ name: roleName }));
      }
      roleId = existingRole.id;
    }
  } else {
    throw new ValidationError("Role is required");
  }

  if (payload.closesAt && payload.closesAt < todayUtc()) {
    throw new ValidationError("The closing date can't be in the past");
  }

  if (payload.aiConfigId) {
    const existingConfig = await aiConfigRepo().findOne({ where: { id: payload.aiConfigId } });
    if (!existingConfig) {
      throw new NotFoundError("Config does not exist");
    }
  }

  const location = locationFieldsForWorkMode(payload);

  // Create vector embedding for Job description
  const jd = preprocessText(payload.jobBrief);
  const jobEmbedding = await createEmbedding(jd);
  if (!jobEmbedding || !jobEmbedding[0]?.embedding) {
    throw new ValidationError("Unable to create vector embedding for JD");
  }

  const job = jobRepo().create({
    ...pickEditableJobFields(payload),
    ...location,
    status: JobStatus.Draft,
    roleId,
    postedById: userId,
    organizationId,
    aiConfigId: payload.aiConfigId ?? null,
  });

  const saved = await jobRepo().save(job);

  // Store embedding directly on the Job entity column
  const embeddingStr = `[${jobEmbedding[0]!.embedding.toString()}]`;
  await jobRepo()
    .createQueryBuilder()
    .update(Job)
    .set({ jobEmbedding: embeddingStr })
    .where("id = :id", { id: saved.id })
    .execute();

  return saved;
};

export interface GenerateJobContentPayload {
  role?: string;
  experienceLevel?: string;
  keywords?: string[];
  prompt?: string;
  sourceText?: string;
  richText?: boolean;
}

export interface GeneratedJobContent {
  role: string;
  experienceLevel: ExperienceLevel | null;
  workMode: WorkMode[];
  locationCountry: string | null;
  locationState: string | null;
  locationCity: string | null;
  currency: JobCurrency | null;
  minSalary: number | null;
  maxSalary: number | null;
  compensationPeriod: CompensationPeriod | null;
  jobBrief: string;
  requirements: string;
  skills: string[];
  goals: string[];
}

// Job posts take the same currencies the recruiter form offers, wider than the profile Currency enum.
const JOB_CURRENCIES = ["NGN", "USD", "GBP", "EUR"] as const;
type JobCurrency = (typeof JOB_CURRENCIES)[number];

const oneOf = <T extends string>(values: readonly T[], value: unknown): T | null =>
  values.includes(value as T) ? (value as T) : null;

const nonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const positiveNumber = (value: unknown): number | null => {
  const num = typeof value === "string" ? Number(value) : value;
  return typeof num === "number" && Number.isFinite(num) && num > 0 ? num : null;
};

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && !!item.trim())
    : [];

const parseLlmJson = (response: { message: { content: string | null } } | undefined) => {
  if (!response?.message.content) {
    throw new ValidationError("Error with LLM");
  }
  try {
    return JSON.parse(response.message.content) as Record<string, unknown>;
  } catch {
    throw new ValidationError("The AI returned an unreadable response. Please try again.");
  }
};

export const generateJobContent = async (
  payload: GenerateJobContentPayload
): Promise<GeneratedJobContent> => {
  const content = parseLlmJson(await generateJobContentAI(payload));

  const minSalary = positiveNumber(content.minSalary);
  let maxSalary = positiveNumber(content.maxSalary);
  if (minSalary !== null && maxSalary !== null && maxSalary <= minSalary) {
    maxSalary = null;
  }

  return {
    role: nonEmptyString(payload.role) ?? nonEmptyString(content.role) ?? "",
    experienceLevel: oneOf(Object.values(ExperienceLevel), content.experienceLevel),
    workMode: stringList(content.workMode).filter((mode): mode is WorkMode =>
      Object.values(WorkMode).includes(mode as WorkMode)
    ),
    locationCountry: nonEmptyString(content.locationCountry),
    locationState: nonEmptyString(content.locationState),
    locationCity: nonEmptyString(content.locationCity),
    currency: oneOf(JOB_CURRENCIES, content.currency),
    minSalary,
    maxSalary,
    compensationPeriod: oneOf(Object.values(CompensationPeriod), content.compensationPeriod),
    jobBrief: nonEmptyString(content.jobBrief) ?? "",
    requirements: nonEmptyString(content.requirements) ?? "",
    skills: stringList(content.skills),
    goals: stringList(content.goals),
  };
};

// mammoth (used by extractText) only supports .docx, not legacy binary .doc.
const JOB_DESCRIPTION_FILE_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
];

const MAX_SOURCE_TEXT_LENGTH = 30000;

export const generateJobContentFromFile = async (
  file: Express.Multer.File | undefined,
  options: { richText?: boolean } = {}
): Promise<GeneratedJobContent> => {
  if (!file) {
    throw new ValidationError("Upload a job description file");
  }
  if (!JOB_DESCRIPTION_FILE_TYPES.includes(file.mimetype)) {
    throw new ValidationError("Upload a PDF, DOCX or TXT file");
  }
  if (file.size === 0) {
    throw new ValidationError("File is empty");
  }

  let text: string;
  try {
    text =
      file.mimetype === "text/plain"
        ? file.buffer.toString("utf8")
        : await extractText(file.buffer, file.mimetype);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Job description extraction failed: ${message}`);
    throw new ValidationError("We couldn't read this file. Please upload a PDF, DOCX or TXT file.");
  }
  if (!text?.trim()) {
    throw new ValidationError("We couldn't find any text in this file");
  }

  return generateJobContent({
    sourceText: text.trim().slice(0, MAX_SOURCE_TEXT_LENGTH),
    ...(options.richText ? { richText: true } : {}),
  });
};

export type GenerateJobFieldPayload = GenerateJobFieldContext;

export interface GeneratedJobField {
  text?: string;
  suggestions?: string[];
}

export const generateJobField = async (
  payload: GenerateJobFieldPayload
): Promise<GeneratedJobField> => {
  const content = parseLlmJson(await generateJobFieldAI(payload));

  if (payload.field === "skills" || payload.field === "goals") {
    const existing = new Set((payload.job[payload.field] ?? []).map((item) => item.toLowerCase()));
    const suggestions = stringList(content.items)
      .map((item) => item.trim())
      .filter((item) => !existing.has(item.toLowerCase()));
    return { suggestions: [...new Set(suggestions)] };
  }

  const text = nonEmptyString(content.text);
  if (!text) {
    throw new ValidationError("The AI returned an empty response. Please try again.");
  }
  return { text };
};

// Fire and forget, chunked to avoid bulk write timeouts.
const notifyApplicantsOfStatus = (jobId: string, status: JobStatus): void => {
  (async () => {
    const applications = await applicationRepo().find({ where: { jobId } });
    const notifications = applications
      .filter(
        (app) =>
          app.status !== ApplicationStatus.Shortlisted && app.status !== ApplicationStatus.Rejected
      )
      .map((app) =>
        notificationRepo().create({
          userId: app.talentId,
          message: `Applications for this job has been ${status}`,
        })
      );
    const CHUNK = 500;
    for (let i = 0; i < notifications.length; i += CHUNK) {
      await notificationRepo().save(notifications.slice(i, i + CHUNK));
    }
  })().catch((err: Error) =>
    logger.error(`Notification fan-out failed for job ${jobId}: ${err.message}`)
  );
};

/** Closes active jobs whose closing date has passed. Called by the reconciliation sweep. */
export const closeExpiredJobs = async (): Promise<string[]> => {
  const rows = resultRows(
    await AppDataSource.query(
      `UPDATE "jobs" SET "status" = $1, "updatedAt" = now()
       WHERE "status" = $2 AND "closesAt" < CURRENT_DATE
       RETURNING "id"`,
      [JobStatus.Closed, JobStatus.Active]
    )
  ) as Array<{ id: string }>;
  const ids = rows.map((row) => row.id);
  for (const id of ids) notifyApplicantsOfStatus(id, JobStatus.Closed);
  return ids;
};

export const updateJob = async (
  userId: string,
  userRole: UserRole,
  payload: UpdateJobPayload
): Promise<Job> => {
  const { id, ...update } = payload;

  const existingJob = await jobRepo().findOne({
    where: { id },
    relations: { postedBy: true },
  });
  if (!existingJob) {
    throw new NotFoundError("Job does not exist");
  }

  await assertRecruiterJobAccess(userId, userRole, existingJob);

  if (update.closesAt && update.closesAt !== existingJob.closesAt && update.closesAt < todayUtc()) {
    throw new ValidationError("The closing date can't be in the past");
  }

  if (update.status === JobStatus.Active) {
    const nextAiConfigId =
      update.aiConfigId !== undefined ? update.aiConfigId : existingJob.aiConfigId;
    if (!nextAiConfigId) {
      throw new ValidationError("This job cannot be activated until an AI configuration is added");
    }
    const nextClosesAt = update.closesAt !== undefined ? update.closesAt : existingJob.closesAt;
    if (nextClosesAt && nextClosesAt < todayUtc()) {
      throw new ValidationError("Move the closing date to today or later before publishing");
    }

    // Plan gating is org-wide, shared across every recruiter at the company — only
    // applies the first time a job goes live (re-saving an already-Active job or
    // reactivating shouldn't re-charge/re-count it).
    if (existingJob.status !== JobStatus.Active && existingJob.organizationId) {
      const stored = await organizationRepo().findOne({
        where: { id: existingJob.organizationId },
      });
      if (stored) {
        // Re-check expiry first: a lapsed subscription must fall back to per-job
        // payment rather than keep spending the old plan's listing allowance.
        const org = await ensureOrganizationBillingCurrent(stored);
        // Pay per Use charges every activation, and a subscription whose listing allowance
        // is used up overflows to the same one-time charge instead of being refused. The
        // payment-fulfillment path sets status to Active directly (bypassing updateJob), so
        // this only fires for the recruiter-driven "activate" action.
        const mustPay =
          org.billingPlan === DEFAULT_BILLING_PLAN_KEY ||
          (await isAtLimit(org, "job_listings", () => countActiveJobs(org.id)));
        if (mustPay) {
          update.status = JobStatus.PendingPayment;
        }
      }
    }
  }

  let roleId: string | undefined;
  if (update.role) {
    const existingRole = await roleRepo().findOne({ where: { id: update.role } });
    if (!existingRole) {
      throw new NotFoundError("Role does not exist");
    }
    roleId = existingRole.id;
  }

  if (update.status && update.status !== existingJob.status) {
    notifyApplicantsOfStatus(id, update.status);
  }

  const updateData = {
    ...pickEditableJobFields(update),
    ...(update.status !== undefined ? { status: update.status } : {}),
    ...(roleId !== undefined ? { roleId } : {}),
  };
  const nextWorkMode = updateData.workMode ?? existingJob.workMode;
  const located = locationFieldsForWorkMode({
    workMode: nextWorkMode,
    locationCountry:
      updateData.locationCountry !== undefined
        ? updateData.locationCountry
        : existingJob.locationCountry,
    locationState:
      updateData.locationState !== undefined ? updateData.locationState : existingJob.locationState,
    locationCity:
      updateData.locationCity !== undefined ? updateData.locationCity : existingJob.locationCity,
  });
  const updated = await jobRepo().save({ ...existingJob, ...updateData, ...located });
  return updated;
};

export const deleteJob = async (userId: string, jobId: string): Promise<void> => {
  const job = await jobRepo().findOne({ where: { id: jobId } });
  if (!job) {
    throw new NotFoundError("Job does not exist");
  }
  await assertRecruiterJobAccess(userId, UserRole.Recruiter, job);

  // Full cascade (messages → applications → answers/questions → job + unused AI config).
  await AppDataSource.transaction(async (manager) => {
    await purgeJobCascade(manager, jobId);
  });
};

const buildJobsQuery = async (payload: FetchJobsParams) => {
  const qb = jobRepo()
    .createQueryBuilder("job")
    .leftJoinAndSelect("job.role", "role")
    .leftJoinAndSelect("job.postedBy", "postedBy")
    .leftJoinAndSelect("job.organization", "organization");

  if (payload.roleId) {
    const role = await roleRepo().findOne({ where: { id: payload.roleId } });
    if (!role) {
      throw new NotFoundError("Role does not exist");
    }
    qb.andWhere("job.role_id = :roleId", { roleId: payload.roleId });
  }

  if (payload.status) {
    qb.andWhere("job.status IN (:...statuses)", { statuses: payload.status.split(",") });
  }

  if (payload.employmentType) {
    qb.andWhere('job."employmentType" = :employmentType', {
      employmentType: payload.employmentType,
    });
  }

  const keyword = typeof payload.q === "string" ? payload.q.trim() : "";
  if (keyword) {
    qb.andWhere(
      "(role.name ILIKE :keyword ESCAPE '\\' OR organization.name ILIKE :keyword ESCAPE '\\')",
      {
        keyword: `%${escapeLike(keyword)}%`,
      }
    );
  }

  if (payload.experienceLevel) {
    qb.andWhere("job.experienceLevel = :exp", { exp: payload.experienceLevel });
  }

  if (payload.minMonthlySalary !== undefined && payload.minMonthlySalary !== "") {
    qb.andWhere("job.currency = :salaryCurrency", {
      salaryCurrency: payload.currency ?? Currency.NGN,
    });
    qb.andWhere(
      `(CASE WHEN job."compensationPeriod" = :yearly
          THEN COALESCE(job."maxSalary", job."minSalary") / 12
          ELSE COALESCE(job."maxSalary", job."minSalary") END) >= :minMonthlySalary`,
      { yearly: CompensationPeriod.Yearly, minMonthlySalary: Number(payload.minMonthlySalary) }
    );
  }

  if (payload.postedWithin === "week") {
    qb.andWhere(`job."createdAt" >= NOW() - INTERVAL '7 days'`);
  }

  if (payload.postedBy) {
    qb.andWhere("job.posted_by_id = :postedBy", { postedBy: payload.postedBy });
  }

  if (payload.organizationId) {
    qb.andWhere("job.organization_id = :organizationId", {
      organizationId: payload.organizationId,
    });
  }

  if (payload.city) {
    qb.andWhere("LOWER(job.locationCity) = :city", { city: payload.city.toLowerCase() });
  }

  if (payload.state) {
    qb.andWhere("LOWER(job.locationState) = :state", { state: payload.state.toLowerCase() });
  }

  if (payload.country) {
    qb.andWhere("LOWER(job.locationCountry) = :country", {
      country: payload.country.toLowerCase(),
    });
  }

  if (payload.workMode) {
    const workModes = payload.workMode.split(",").map((m) => m.trim());
    const allowedWorkModes = Object.values(WorkMode);
    for (const mode of workModes) {
      if (!allowedWorkModes.includes(mode as WorkMode)) {
        throw new ValidationError(`Invalid workMode: '${mode}'`);
      }
    }
    // simple-array column — use LIKE or ANY approach for each mode
    qb.andWhere(
      workModes.map((_, i) => `job.workMode LIKE :mode${i}`).join(" OR "),
      workModes.reduce(
        (acc, mode, i) => {
          acc[`mode${i}`] = `%${mode}%`;
          return acc;
        },
        {} as Record<string, string>
      )
    );
  }

  return qb;
};

const pageOf = (payload: FetchJobsParams) => ({
  limit: Math.min(Number(payload.limit) || 50, MAX_PAGE_SIZE),
  offset: Number(payload.offset) || 0,
  order: sortDirection(payload.sort ?? "desc"),
});

export const fetchAllJobs = async (
  payload: FetchJobsParams,
  options: PublicJobOptions = {}
): Promise<{
  jobs: (PublicJob & {
    hasApplied?: boolean;
    applicationStage?: string | null;
    applicationStages?: Record<string, string> | null;
    isSaved?: boolean;
  })[];
  total: number;
}> => {
  const qb = await buildJobsQuery(payload);
  const { limit, offset, order } = pageOf(payload);
  const [jobs, total] = await qb
    .orderBy("job.createdAt", order)
    .skip(offset)
    .take(limit)
    .getManyAndCount();

  if (!payload.talentId || jobs.length === 0) {
    return { jobs: jobs.map((job) => toPublicJob(job, options)), total };
  }

  const jobIds = jobs.map((job) => job.id);
  const [applied, saved] = await Promise.all([
    applicationRepo().find({
      where: { talentId: payload.talentId, jobId: In(jobIds) },
      select: { jobId: true, currentStage: true, stages: true },
    }),
    savedJobIds(payload.talentId, jobIds),
  ]);
  const applicationByJobId = new Map(
    applied.map((application) => [application.jobId, application])
  );

  return {
    jobs: jobs.map((job) => {
      const application = applicationByJobId.get(job.id);
      return Object.assign(toPublicJob(job, options), {
        hasApplied: !!application,
        applicationStage: application?.currentStage ?? null,
        applicationStages: application?.stages ?? null,
        isSaved: saved.has(job.id),
      });
    }),
    total,
  };
};

export interface RecruiterJobCounts {
  all: number;
  active: number;
  draft: number;
  closed: number;
}

export interface RecruiterJobsResult {
  jobs: PublicJob[];
  total: number;
  counts: RecruiterJobCounts;
  states: string[];
}

const COUNT_GROUP: Record<JobStatus, keyof Omit<RecruiterJobCounts, "all">> = {
  [JobStatus.Active]: "active",
  [JobStatus.Draft]: "draft",
  [JobStatus.PendingPayment]: "draft",
  [JobStatus.Closed]: "closed",
  [JobStatus.Suspended]: "closed",
};

const companyJobCounts = async (organizationId: string): Promise<RecruiterJobCounts> => {
  const rows = await jobRepo()
    .createQueryBuilder("job")
    .select("job.status", "status")
    .addSelect("COUNT(*)", "count")
    .where("job.organization_id = :organizationId", { organizationId })
    .groupBy("job.status")
    .getRawMany<{ status: JobStatus; count: string }>();
  const counts: RecruiterJobCounts = { all: 0, active: 0, draft: 0, closed: 0 };
  for (const row of rows) {
    const count = Number(row.count);
    counts.all += count;
    counts[COUNT_GROUP[row.status]] += count;
  }
  return counts;
};

const companyJobStates = async (organizationId: string): Promise<string[]> => {
  const rows = await jobRepo()
    .createQueryBuilder("job")
    .select('DISTINCT TRIM(job."locationState")', "state")
    .where("job.organization_id = :organizationId", { organizationId })
    .andWhere("TRIM(job.\"locationState\") <> ''")
    .getRawMany<{ state: string }>();
  const byKey = new Map<string, string>();
  for (const { state } of rows) {
    const key = state.toLowerCase();
    const kept = byKey.get(key);
    if (!kept || (kept[0] === kept[0]!.toLowerCase() && state[0] !== state[0]!.toLowerCase())) {
      byKey.set(key, state);
    }
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
};

export const fetchRecruiterJobs = async (
  userId: string,
  payload: FetchJobsParams
): Promise<RecruiterJobsResult> => {
  const activeOrgId = await getActiveOrganizationId(userId);
  if (!activeOrgId) {
    return { jobs: [], total: 0, counts: { all: 0, active: 0, draft: 0, closed: 0 }, states: [] };
  }

  const qb = await buildJobsQuery({
    ...payload,
    postedBy: undefined,
    organizationId: activeOrgId,
  });
  const { limit, offset, order } = pageOf(payload);
  const [[jobs, total], counts, states] = await Promise.all([
    qb.orderBy("job.createdAt", order).skip(offset).take(limit).getManyAndCount(),
    companyJobCounts(activeOrgId),
    companyJobStates(activeOrgId),
  ]);

  return {
    jobs: jobs.map((job) => toPublicJob(job, { includeApplicantCount: true })),
    total,
    counts,
    states,
  };
};

export const fetchJob = async (
  jobId: string,
  viewer?: JobViewer
): Promise<
  PublicJob & {
    hasApplied?: boolean;
    applicationStage?: string | null;
    applicationId?: string | null;
    applicationStages?: Record<string, string> | null;
    interviewId?: string | null;
    isSaved?: boolean;
    screening: ScreeningPlanStep[];
  }
> => {
  const job = await jobRepo().findOne({
    where: { id: jobId },
    relations: { role: true, postedBy: true, aiConfig: true, organization: true },
  });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  if (!viewer && job.status !== JobStatus.Active) {
    throw new NotFoundError("Job not found");
  }
  const publicJob = Object.assign(
    toPublicJob(job, { includeApplicantCount: await canSeeApplicantCount(job, viewer) }),
    { screening: screeningPlan(job.aiConfig) }
  );
  if (viewer?.role !== UserRole.Talent) {
    return publicJob;
  }

  const [existingApplication, saved] = await Promise.all([
    applicationRepo().findOne({
      where: { talentId: viewer.id, jobId },
      select: { id: true, currentStage: true, stages: true },
    }),
    savedJobIds(viewer.id, [jobId]),
  ]);
  const interview = existingApplication
    ? await AppDataSource.getRepository(AiInterview).findOne({
        where: { applicationId: existingApplication.id, status: In(["ready", "invited"]) },
        select: { id: true },
      })
    : null;
  return Object.assign(publicJob, {
    hasApplied: !!existingApplication,
    applicationStage: existingApplication?.currentStage ?? null,
    applicationId: existingApplication?.id ?? null,
    applicationStages: existingApplication?.stages ?? null,
    interviewId: interview?.id ?? null,
    isSaved: saved.has(jobId),
  });
};

export const matchJob = async (
  userId: string,
  userRole: UserRole,
  payload: MatchJobParams
): Promise<User[]> => {
  const job = await jobRepo().findOne({
    where: { id: payload.id },
    relations: { role: true, postedBy: true },
  });
  if (!job) {
    throw new NotFoundError("Job not found");
  }

  await assertRecruiterJobAccess(userId, userRole, job);

  const qb = userRepo()
    .createQueryBuilder("user")
    .leftJoinAndSelect("user.userRoles", "userRoles")
    .where("user.userRole = :role", { role: UserRole.Talent })
    .andWhere("userRoles.id = :roleId", { roleId: job.roleId })
    .andWhere("user.experience = :exp", { exp: job.experienceLevel });

  // A job with no max salary has no ceiling to filter talents against.
  if (job.maxSalary != null) {
    qb.andWhere("user.maxSalary <= :maxSalary", { maxSalary: job.maxSalary });
  }

  if (payload.incomplete !== "true") {
    qb.andWhere("user.prescreeningScore IS NOT NULL");
  }

  return qb.orderBy("user.prescreeningScore", "DESC").getMany();
};

export interface TalentWithFitEvidence extends User {
  strengths?: string[];
  weaknesses?: string[];
}

// Ranks talents by pgvector cosine-distance between their CV embedding and this
// job's embedding. Read-only — callers decide what (if anything) to do with the
// result; this must never be the thing that creates/mutates Application rows.
export const rankTalentIdsByJobEmbedding = (
  jobId: string,
  strictness: number,
  limit: number
): Promise<Array<{ user_id: string; similarity: number }>> =>
  AppDataSource.query(
    `
    WITH jd_cte AS (
      SELECT job_embedding::vector FROM jobs WHERE id = $1
    ),
    similarity_cte AS (
      SELECT
        te.user_id,
        te.cv_text,
        ABS((SELECT job_embedding::vector FROM jd_cte) <=> te.cv_embedding::vector) AS similarity
      FROM talent_embeddings te
    )
    SELECT user_id, similarity
    FROM (
      -- A talent has one row per CV chunk, so each is reduced to the chunk that
      -- matches this job best. The <=> operator is cosine DISTANCE, so the best
      -- chunk is the smallest value: ordering DESC here picked each talent's
      -- worst chunk as their representative score, pushing good candidates down.
      SELECT user_id, similarity,
        ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY similarity ASC) AS rn
      FROM similarity_cte
    ) ranked
    WHERE rn = 1 AND similarity <= $2
    ORDER BY similarity
    LIMIT $3
    `,
    [jobId, strictness, limit]
  );

export const topTalents = async (
  userId: string,
  userRole: UserRole,
  payload: TopTalentsParams
): Promise<{ talents: TalentWithFitEvidence[]; newApplicants: number }> => {
  const { jobId } = payload;

  const job = await jobRepo().findOne({
    where: { id: jobId },
    relations: { postedBy: true, aiConfig: true },
  });
  if (!job) {
    throw new NotFoundError("Job does not exist");
  }

  await assertRecruiterJobAccess(userId, userRole, job);

  const aiConfig = job.aiConfig;
  if (!aiConfig) {
    throw new NotFoundError("AI configuration for job not found");
  }

  if (!aiConfig.cvSimilarity) {
    throw new ValidationError("This feature was not configured for this job");
  }

  const limit = payload.limit ?? 20;
  const percentage = payload.percentage ?? aiConfig.minCvSimilarityScore ?? 50;
  const strictness = (100 - percentage) / 100;

  const res = await rankTalentIdsByJobEmbedding(jobId, strictness, limit);

  const talentIds = res.map((r) => r.user_id);

  // Get next stage for cv_similarity from aiConfig stages
  const stages = aiConfig.stages ?? {};
  const currentStage = stages[ScreeningStage.CvSimilarity] ?? ScreeningStage.Prescreening;

  // Bulk fetch existing applications for all matched talents in a single query
  const existingApps =
    talentIds.length > 0
      ? await applicationRepo().find({ where: talentIds.map((tid) => ({ jobId, talentId: tid })) })
      : [];
  const existingAppMap = new Map(existingApps.map((a) => [a.talentId, a]));

  const toSave: Application[] = [];
  let newApplicants = 0;

  for (const r of res) {
    const cvSimilarityScore = convertSimilarityToPercentage(Math.min(Math.max(r.similarity, 0), 1));
    const existing = existingAppMap.get(r.user_id);

    if (existing) {
      toSave.push(
        applicationRepo().create({
          ...existing,
          cvSimilarityScore,
          currentStage: currentStage as Application["currentStage"],
        })
      );
    } else {
      toSave.push(
        applicationRepo().create({
          jobId,
          talentId: r.user_id,
          recruiterId: userId,
          applicationType: ApplicationType.Invitation,
          stages: aiConfig.stages,
          cvSimilarityScore,
          currentStage: currentStage as Application["currentStage"],
        })
      );
      newApplicants++;
    }
  }

  // Bulk save all upserts in one query
  if (toSave.length > 0) {
    await applicationRepo().save(toSave);
  }

  // Update noOfApplicants on job
  if (newApplicants > 0) {
    await AppDataSource.query(
      'UPDATE jobs SET "noOfApplicants" = "noOfApplicants" + $1 WHERE id = $2',
      [newApplicants, jobId]
    );
  }

  // Fetch user details for matched talents
  const talents: TalentWithFitEvidence[] =
    talentIds.length > 0
      ? await userRepo()
          .createQueryBuilder("user")
          .whereInIds(talentIds)
          .leftJoinAndSelect("user.userRoles", "userRoles")
          .getMany()
      : [];

  await enrichTalentsWithFitEvidence(job.jobBrief, talents);

  return { talents, newApplicants };
};

// Bounded to the top-N list already returned by topTalents/searchTalents (never
// the full candidate pool) so cost/latency stay in check. Best-effort: a failure
// for one candidate must never block the others or the overall response.
export const enrichTalentsWithFitEvidence = async (
  jobDescription: string,
  talents: TalentWithFitEvidence[]
): Promise<void> => {
  if (talents.length === 0) return;

  const talentIds = talents.map((t) => t.id);
  const cvChunks = await talentEmbeddingRepo().find({
    where: { userId: In(talentIds) },
    select: { userId: true, cvText: true },
  });
  const cvTextByUserId = new Map<string, string>();
  for (const chunk of cvChunks) {
    const existing = cvTextByUserId.get(chunk.userId) ?? "";
    cvTextByUserId.set(
      chunk.userId,
      existing ? `${existing}\n\n${chunk.cvText ?? ""}` : (chunk.cvText ?? "")
    );
  }

  await Promise.all(
    talents.map(async (talent) => {
      const cvText = cvTextByUserId.get(talent.id);
      if (!cvText) return;
      try {
        const response = await assessTalentFit({ jobDescription, cvText });
        if (!response?.message.content) return;
        const parsed = JSON.parse(response.message.content) as {
          strengths?: string[];
          weaknesses?: string[];
        };
        talent.strengths = Array.isArray(parsed.strengths) ? parsed.strengths : undefined;
        talent.weaknesses = Array.isArray(parsed.weaknesses) ? parsed.weaknesses : undefined;
      } catch (err) {
        logger.error(
          `Talent fit evidence generation failed for talent ${talent.id}: ${(err as Error).message}`
        );
      }
    })
  );
};

export interface JobApplicationsParams {
  jobId: string;
  applicationType?: ApplicationType;
  applicationStatus?: ApplicationStatus;
  minCvSimilarityScore?: string | number;
  minPersonalizedScore?: string | number;
  minMatchScore?: string | number;
  matchVerdict?: MatchVerdict;
  experience?: string;
  maxSalary?: string | number;
  source?: string;
  q?: string;
  boardColumn?: BoardColumn;
  interview?: InterviewProgress;
  offset?: number | string;
  limit?: number | string;
  /** Defaults to "aiMatch" — best AI match first, matching what the applicant table shows. */
  sort?: "aiMatch" | "dateApplied" | "cvSimilarity";
}

export type JobApplicationRow = Application & ApplicationProgress;

export interface JobApplicationsResult {
  applications: JobApplicationRow[];
  total: number;
  aiConfig: {
    cvSimilarity: boolean;
    minCvSimilarityScore: number | null;
    minPrescreeningScore: number | null;
  } | null;
}

export const jobApplications = async (
  userId: string,
  userRole: UserRole,
  payload: JobApplicationsParams
): Promise<JobApplicationsResult> => {
  const { jobId } = payload;

  const job = await jobRepo().findOne({ where: { id: jobId }, relations: { aiConfig: true } });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  await assertRecruiterJobAccess(userId, userRole, job);

  const qb = applicationRepo()
    .createQueryBuilder("application")
    .leftJoinAndSelect("application.talent", "talent")
    .leftJoin(AiInterview, "interview", "interview.applicationId = application.id")
    .where("application.job_id = :jobId", { jobId });

  const search = payload.q?.trim();
  if (search) {
    qb.andWhere(
      "(CONCAT_WS(' ', talent.firstName, talent.lastName) ILIKE :search ESCAPE '\\' OR talent.email ILIKE :search ESCAPE '\\')",
      { search: `%${escapeLike(search)}%` }
    );
  }

  if (payload.boardColumn) {
    qb.andWhere(`${boardColumnSql("application", "talent")} = :boardColumn`, {
      boardColumn: payload.boardColumn,
    });
  }

  if (payload.interview) {
    qb.andWhere(`${interviewProgressSql("interview")} = :interviewProgress`, {
      interviewProgress: payload.interview,
    });
  }

  if (payload.applicationType) {
    qb.andWhere("application.applicationType = :applicationType", {
      applicationType: payload.applicationType,
    });
  }

  if (payload.applicationStatus) {
    qb.andWhere("application.status = :status", { status: payload.applicationStatus });
  }

  if (payload.minCvSimilarityScore) {
    qb.andWhere("application.cvSimilarityScore >= :minCvScore", {
      minCvScore: Number(payload.minCvSimilarityScore),
    });
  }

  if (payload.minPersonalizedScore) {
    qb.andWhere("application.personalizedScore >= :minPersonalized", {
      minPersonalized: Number(payload.minPersonalizedScore),
    });
  }

  if (payload.minMatchScore) {
    qb.andWhere("application.overallFitScore >= :minMatchScore", {
      minMatchScore: Number(payload.minMatchScore),
    });
  }

  if (payload.matchVerdict) {
    qb.andWhere("application.matchVerdict = :matchVerdict", {
      matchVerdict: payload.matchVerdict,
    });
  }

  if (payload.experience) {
    qb.andWhere("talent.experience = :experience", { experience: payload.experience });
  }

  if (payload.source) {
    qb.andWhere("LOWER(application.source) = :source", {
      source: payload.source.trim().toLowerCase(),
    });
  }

  if (payload.maxSalary) {
    qb.andWhere("talent.maxSalary <= :maxSalary", { maxSalary: Number(payload.maxSalary) });
  }

  const offset = Number(payload.offset) || 0;
  const limit = Math.min(Number(payload.limit) || 50, MAX_PAGE_SIZE);
  const total = await qb.clone().getCount();

  // "aiMatch" (the default) mirrors the applicant table's own default sort —
  // best verdict first, then fit score, then most recent. Still-screening
  // applications (no verdict yet) sort last, below a completed-but-failed one.
  if (payload.sort === "cvSimilarity") {
    qb.orderBy("application.cvSimilarityScore", "DESC").addOrderBy(
      "application.personalizedScore",
      "DESC"
    );
  } else if (payload.sort === "dateApplied") {
    qb.orderBy("application.createdAt", "DESC");
  } else {
    // A raw multi-line CASE string passed straight to .orderBy() trips
    // TypeORM's alias-resolution parser (it mistakes the quoted "application"
    // inside the expression for an unjoined alias reference and throws).
    // Selecting it as an aliased computed column and ordering by that plain
    // alias sidesteps the parser entirely.
    qb.addSelect(
      `CASE
        WHEN "application"."currentStage" != 'completed' THEN 4
        WHEN "application"."matchVerdict" = 'high' THEN 0
        WHEN "application"."matchVerdict" = 'medium' THEN 1
        WHEN "application"."matchVerdict" = 'low' THEN 2
        ELSE 3
      END`,
      "verdict_rank"
    )
      .orderBy("verdict_rank", "ASC")
      .addOrderBy("application.overallFitScore", "DESC", "NULLS LAST");
  }
  qb.addOrderBy("application.createdAt", "DESC");

  const applications = await qb.skip(offset).take(limit).getMany();

  const ids = applications.map((a) => a.id);
  const [recommendations, progress] = await Promise.all([
    loadRecommendationsByApplicationIds(ids),
    loadApplicationProgress(ids),
  ]);
  return {
    applications: applications.map((application) =>
      Object.assign(
        overlayVerdictFromRecommendation(application, recommendations.get(application.id)),
        progress.get(application.id) ?? NO_PROGRESS
      )
    ),
    total,
    aiConfig: job.aiConfig
      ? {
          cvSimilarity: job.aiConfig.cvSimilarity,
          minCvSimilarityScore: job.aiConfig.minCvSimilarityScore,
          minPrescreeningScore: job.aiConfig.minPrescreeningScore,
        }
      : null,
  };
};

// Recruiter-triggered retry for an application with no CV match score. When the
// talent's CV embedding is missing or failed it's regenerated first.
export const retryCvSimilarityScore = async (
  userId: string,
  jobId: string,
  applicationId: string
): Promise<Application> => {
  const job = await jobRepo().findOne({ where: { id: jobId }, relations: { aiConfig: true } });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  await assertRecruiterJobAccess(userId, UserRole.Recruiter, job);

  if (!job.aiConfig?.cvSimilarity) {
    throw new ValidationError("CV matching is not configured for this job");
  }

  const application = await applicationRepo().findOne({
    where: { id: applicationId, jobId },
    relations: { talent: true },
  });
  if (!application) {
    throw new NotFoundError("Application not found");
  }

  const scored = await rescoreCvSimilarity(application.talent, application, job.aiConfig);
  if (scored) return scored;

  try {
    await regenerateCvEmbedding(application.talentId);
  } catch (err) {
    logger.error(
      `CV re-embed failed during score retry for application ${applicationId}: ${
        (err as Error).message
      }`
    );
    throw new ValidationError("This talent's CV could not be processed. Please try again later");
  }

  const reloaded = await applicationRepo().findOne({ where: { id: applicationId } });
  if (reloaded?.cvSimilarityScore === null || reloaded?.cvSimilarityScore === undefined) {
    throw new ValidationError("The CV match score could not be calculated. Please try again later");
  }
  return reloaded;
};

export interface RetryVerdictsResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

export const retryMissingVerdicts = async (
  userId: string,
  jobId: string,
  applicationIds?: string[]
): Promise<RetryVerdictsResult> => {
  const job = await jobRepo().findOne({ where: { id: jobId } });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  await assertRecruiterJobAccess(userId, UserRole.Recruiter, job);

  // An explicit empty list means "retry nothing" — distinct from omitting
  // applicationIds entirely, which means "sweep every missing/failed verdict
  // on this job." Don't let `[]` silently fall through to a full sweep.
  if (applicationIds && applicationIds.length === 0) {
    return { attempted: 0, succeeded: 0, failed: 0 };
  }

  // Recommendations are generated once and never overwritten (see
  // persistRecommendation), so retrying only ever does something for a
  // candidate that's missing a verdict or whose generation failed — scope to
  // those even when applicationIds narrows to a single "Regenerate" click.
  const idScope = applicationIds ? { id: In(applicationIds) } : {};
  const applications = await applicationRepo().find({
    where: [
      { jobId, ...idScope, currentStage: ScreeningStage.Completed, matchVerdict: IsNull() },
      {
        jobId,
        ...idScope,
        currentStage: ScreeningStage.Completed,
        matchVerdictStatus: MatchVerdictStatus.Failed,
      },
    ],
    relations: { talent: true },
  });

  await Promise.all(
    applications.map(async (application) => {
      await resetMatchVerdictRetry(application.id);
      application.matchVerdictStatus = MatchVerdictStatus.Pending;
      application.matchVerdictAttempts = 0;
      application.matchVerdictNextRetryAt = null;
      application.matchVerdictLockedAt = null;
      return triggerMatchVerdict(application.talent, application);
    })
  );

  const ids = applications.map((a) => a.id);
  const succeeded = ids.length
    ? await applicationRepo().count({ where: { id: In(ids), matchVerdict: Not(IsNull()) } })
    : 0;

  return {
    attempted: applications.length,
    succeeded,
    failed: applications.length - succeeded,
  };
};

export interface ApplyPayload {
  jobId: string;
  source?: string;
}

export const apply = async (user: User, payload: ApplyPayload): Promise<Application> => {
  const { jobId, source } = payload;

  const job = await jobRepo().findOne({
    where: { id: jobId },
    relations: { postedBy: true, aiConfig: true },
  });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  if (job.status !== JobStatus.Active) {
    throw new ValidationError(`Applications for this job is currently ${job.status}`);
  }

  const aiConfig = job.aiConfig;
  if (!aiConfig) {
    throw new NotFoundError("AI configuration for job not found");
  }

  const existingApp = await applicationRepo().findOne({
    where: { jobId, talentId: user.id },
  });
  if (existingApp) {
    return existingApp;
  }

  // Application is created immediately on apply, regardless of assessment completion —
  // every stage (including Pre-Assessment) is completed progressively afterward.
  const { stages, entryStage } = createStages(aiConfig);

  const application = applicationRepo().create({
    talentId: user.id,
    jobId,
    applicationType: ApplicationType.Application,
    source: source?.trim().toLowerCase() || null,
    stages,
    recruiterId: job.postedById,
    currentStage: entryStage as Application["currentStage"],
    status: ApplicationStatus.Pending,
    cvSimilarityScore: aiConfig.cvSimilarity
      ? await computeCvSimilarityScore(jobId, user.id)
      : null,
  });

  const saved = await applicationRepo().save(application);
  startAiInterviewIfReached(saved, entryStage);

  // Increment noOfApplicants
  await jobRepo()
    .createQueryBuilder()
    .update(Job)
    .set({ noOfApplicants: () => '"noOfApplicants" + 1' })
    .where("id = :id", { id: jobId })
    .execute();

  try {
    await syncCandidateStage(saved.id);
  } catch (error) {
    logger.warn(`Stage sync after applying failed for application ${saved.id}: ${String(error)}`);
    return saved;
  }
  return applicationRepo().findOneByOrFail({ id: saved.id });
};

export interface AddScoutToJobPipelinePayload {
  scoutId: string;
  jobId: string;
  talentEmail: string;
}

// Phase 1, manual link: Scout has no extracted candidate identity (cvName is
// just the filename) and ScoutJob is scoped to a Role, not a specific Job
// posting, so there's no way to auto-resolve either "which job" or "which
// talent account". The recruiter supplies both explicitly — no CV-email
// extraction, no silently-created accounts. If no talent account exists yet
// for the given email, that's surfaced directly rather than worked around.
//
// Deliberately does not copy scout.evaluationScore/insights onto the
// Application — that's a differently-computed score than cvSimilarityScore,
// and writing into matchVerdictReasoning directly would recreate the exact
// ai_recommendations/Application drift this codebase already had to fix
// elsewhere. The normal pipeline computes everything once the talent
// proceeds; Scout's job here is just sourcing the invite.
export const addScoutToJobPipeline = async (
  userId: string,
  payload: AddScoutToJobPipelinePayload
): Promise<Application> => {
  const { scoutId, jobId, talentEmail } = payload;

  const scout = await scoutRepo().findOne({
    where: { id: scoutId },
    relations: { scoutJob: true },
  });
  if (!scout) {
    throw new NotFoundError("Scout report not found");
  }
  await assertCompanyResourceAccess(
    userId,
    UserRole.Recruiter,
    scout.scoutJob?.organizationId,
    scout.recruiterId
  );

  const job = await jobRepo().findOne({
    where: { id: jobId },
    relations: { aiConfig: true },
  });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  await assertRecruiterJobAccess(userId, UserRole.Recruiter, job);
  if (
    scout.scoutJob?.organizationId &&
    job.organizationId &&
    scout.scoutJob.organizationId !== job.organizationId
  ) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }
  if (job.status !== JobStatus.Active) {
    throw new ValidationError(`Applications for this job is currently ${job.status}`);
  }

  const aiConfig = job.aiConfig;
  if (!aiConfig) {
    throw new NotFoundError("AI configuration for job not found");
  }

  const talent = await userRepo().findOne({
    where: { email: talentEmail.trim().toLowerCase(), userRole: UserRole.Talent },
  });
  if (!talent) {
    throw new NotFoundError(
      "No talent account found with that email — ask them to create a profile first"
    );
  }

  const existingApp = await applicationRepo().findOne({
    where: { jobId, talentId: talent.id },
  });
  if (existingApp) {
    return existingApp;
  }

  const { stages, entryStage } = createStages(aiConfig);

  const application = applicationRepo().create({
    talentId: talent.id,
    jobId,
    applicationType: ApplicationType.Invitation,
    stages,
    recruiterId: job.postedById,
    currentStage: entryStage as Application["currentStage"],
    status: ApplicationStatus.Pending,
  });

  const saved = await applicationRepo().save(application);

  await jobRepo()
    .createQueryBuilder()
    .update(Job)
    .set({ noOfApplicants: () => '"noOfApplicants" + 1' })
    .where("id = :id", { id: jobId })
    .execute();

  return saved;
};

// Called when a talent lands on an application currently parked at the (global,
// job-agnostic) Prescreening stage — mirrors the CV-similarity auto-trigger pattern.
// Idempotent no-op if the application isn't at that stage yet, or the talent hasn't
// completed the global Pre-Assessment yet.
export const checkPrescreeningAdvance = async (
  userId: string,
  jobId: string
): Promise<Application> => {
  const application = await applicationRepo().findOne({ where: { jobId, talentId: userId } });
  if (!application) {
    throw new NotFoundError("Job application not found");
  }
  await syncCandidateStage(application.id);
  return applicationRepo().findOneByOrFail({ id: application.id });
};
