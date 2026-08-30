import { In, IsNull, Not } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import logger from "../utils/logger.js";
import { Job } from "../entities/Job.js";
import { Role } from "../entities/Role.js";
import { AIConfig } from "../entities/AIConfig.js";
import { Application } from "../entities/Application.js";
import { User } from "../entities/User.js";
import { Notification } from "../entities/Notification.js";
import { Scout } from "../entities/Scout.js";
import { NotFoundError, AuthorizationError, ValidationError } from "../utils/errors";
import { purgeJobCascade } from "./cascadeDelete.js";
import {
  UserRole,
  JobStatus,
  WorkMode,
  ApplicationType,
  ApplicationStatus,
  ScreeningStage,
  CompensationPeriod,
} from "../types/enums.js";
import {
  createEmbedding,
  generateJobContent as generateJobContentAI,
  assessTalentFit,
} from "../utils/integrations/openai.js";
import { TalentEmbedding } from "../entities/TalentEmbedding.js";
import { convertSimilarityToPercentage, preprocessText, sortDirection } from "../utils/text.js";
import { workModeNeedsLocation } from "../utils/workMode.js";
import { createStages } from "./aiConfig.js";
import {
  getAssessmentRetryDate,
  processNextStage,
  loadRecommendationsByApplicationIds,
  overlayVerdictFromRecommendation,
  triggerMatchVerdict,
} from "./applicationStage.js";
import { isPrescreeningScoreValid } from "./prescreening.js";

const jobRepo = () => AppDataSource.getRepository(Job);

const roleRepo = () => AppDataSource.getRepository(Role);

const MAX_PAGE_SIZE = 100;

const aiConfigRepo = () => AppDataSource.getRepository(AIConfig);

const applicationRepo = () => AppDataSource.getRepository(Application);

const userRepo = () => AppDataSource.getRepository(User);

const notificationRepo = () => AppDataSource.getRepository(Notification);

const talentEmbeddingRepo = () => AppDataSource.getRepository(TalentEmbedding);

const scoutRepo = () => AppDataSource.getRepository(Scout);

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
}

export interface UpdateJobPayload extends Partial<CreateJobPayload> {
  id: string;
  status?: JobStatus;
}

export interface FetchJobsParams {
  roleId?: string;
  status?: JobStatus;
  experienceLevel?: string;
  postedBy?: string;
  city?: string;
  state?: string;
  country?: string;
  workMode?: string;
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

  // Exclude the 'role' string field (used only for lookup) to avoid type conflict
  const { role: _role, ...jobData } = payload;
  const job = jobRepo().create({
    ...jobData,
    ...location,
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
  role: string;
  experienceLevel?: string;
  keywords?: string[];
}

export interface GeneratedJobContent {
  jobBrief: string;
  requirements: string;
  skills: string[];
  goals: string[];
}

export const generateJobContent = async (
  payload: GenerateJobContentPayload
): Promise<GeneratedJobContent> => {
  const response = await generateJobContentAI(payload);
  if (!response || !response.message.content) {
    throw new ValidationError("Error with LLM");
  }
  const content = JSON.parse(response.message.content);
  return {
    jobBrief: content.jobBrief ?? "",
    requirements: content.requirements ?? "",
    skills: Array.isArray(content.skills) ? content.skills : [],
    goals: Array.isArray(content.goals) ? content.goals : [],
  };
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

  if (existingJob.postedById !== userId) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }

  if (update.status === JobStatus.Active) {
    const nextAiConfigId =
      update.aiConfigId !== undefined ? update.aiConfigId : existingJob.aiConfigId;
    if (!nextAiConfigId) {
      throw new ValidationError("This job cannot be activated until an AI configuration is added");
    }
  }

  if (update.role) {
    const existingRole = await roleRepo().findOne({ where: { id: update.role } });
    if (!existingRole) {
      throw new NotFoundError("Role does not exist");
    }
    (update as Record<string, unknown>)["roleId"] = existingRole.id;
    delete (update as Record<string, unknown>)["role"];
  }

  // Notify applicants when job status changes — fire and forget, chunked to avoid bulk write timeouts
  if (update.status && update.status !== existingJob.status) {
    const statusLabel = update.status;
    const jobId = id;
    (async () => {
      const applications = await applicationRepo().find({ where: { jobId } });
      const notifications = applications
        .filter(
          (app) =>
            app.status !== ApplicationStatus.Shortlisted &&
            app.status !== ApplicationStatus.Rejected
        )
        .map((app) =>
          notificationRepo().create({
            userId: app.talentId,
            message: `Applications for this job has been ${statusLabel}`,
          })
        );
      const CHUNK = 500;
      for (let i = 0; i < notifications.length; i += CHUNK) {
        await notificationRepo().save(notifications.slice(i, i + CHUNK));
      }
    })().catch((err: Error) =>
      logger.error(`Notification fan-out failed for job ${id}: ${err.message}`)
    );
  }

  // Exclude 'role' string field to avoid type conflict with Role entity
  const { role: _role2, ...updateData } = update;
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
  if (job.postedById !== userId) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }

  // Full cascade (messages → applications → answers/questions → job + unused AI config).
  await AppDataSource.transaction(async (manager) => {
    await purgeJobCascade(manager, jobId);
  });
};

export const fetchAllJobs = async (
  payload: FetchJobsParams
): Promise<(Job & { hasApplied?: boolean; applicationStage?: string | null })[]> => {
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
    qb.andWhere("job.status = :status", { status: payload.status });
  }

  if (payload.experienceLevel) {
    qb.andWhere("job.experienceLevel = :exp", { exp: payload.experienceLevel });
  }

  if (payload.postedBy) {
    qb.andWhere("job.posted_by_id = :postedBy", { postedBy: payload.postedBy });
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

  const limit = Math.min(Number(payload.limit) || 50, MAX_PAGE_SIZE);
  const offset = Number(payload.offset) || 0;
  const order = sortDirection(payload.sort ?? "desc");

  const jobs = await qb.orderBy("job.createdAt", order).skip(offset).take(limit).getMany();

  if (!payload.talentId || jobs.length === 0) {
    return jobs;
  }

  const applied = await applicationRepo().find({
    where: { talentId: payload.talentId, jobId: In(jobs.map((job) => job.id)) },
    select: { jobId: true, currentStage: true },
  });
  const stageByJobId = new Map(
    applied.map((application) => [application.jobId, application.currentStage])
  );

  return jobs.map((job) =>
    Object.assign(job, {
      hasApplied: stageByJobId.has(job.id),
      applicationStage: stageByJobId.get(job.id) ?? null,
    })
  );
};

export const fetchJob = async (
  jobId: string,
  talentId?: string,
  isAuthenticated?: boolean
): Promise<
  Job & {
    hasApplied?: boolean;
    applicationStage?: string | null;
    applicationId?: string | null;
    applicationStages?: Record<string, string> | null;
  }
> => {
  const job = await jobRepo().findOne({
    where: { id: jobId },
    relations: { role: true, postedBy: true, aiConfig: true, organization: true },
  });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  if (!isAuthenticated && job.status !== JobStatus.Active) {
    throw new NotFoundError("Job not found");
  }
  if (!talentId) {
    return job;
  }

  const existingApplication = await applicationRepo().findOne({
    where: { talentId, jobId },
    select: { id: true, currentStage: true, stages: true },
  });
  return Object.assign(job, {
    hasApplied: !!existingApplication,
    applicationStage: existingApplication?.currentStage ?? null,
    applicationId: existingApplication?.id ?? null,
    applicationStages: existingApplication?.stages ?? null,
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

  if (job.postedById !== userId && userRole !== UserRole.Admin) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }

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
      SELECT user_id, similarity,
        ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY similarity DESC) AS rn
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

  if (job.postedById !== userId && userRole !== UserRole.Admin) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }

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
    const cvSimilarityScore = convertSimilarityToPercentage(r.similarity);
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

export const gradeCv = async (
  userId: string,
  jobId: string
): Promise<{ cvSimilarityScore: number; application: Application }> => {
  const job = await jobRepo().findOne({
    where: { id: jobId },
    relations: { aiConfig: true },
  });
  if (!job) {
    throw new NotFoundError("Job does not exist");
  }

  if (job.status === JobStatus.Closed) {
    throw new ValidationError(`Applications for this job is currently ${job.status}`);
  }

  let application = await applicationRepo().findOne({
    where: { jobId, talentId: userId },
  });
  if (!application) {
    throw new ValidationError("You have to apply for this job before proceeding");
  }

  if (application.currentStage !== ScreeningStage.CvSimilarity) {
    throw new ValidationError("This stage is not currently active for this application");
  }

  const aiConfig = job.aiConfig;
  if (!aiConfig) {
    throw new NotFoundError("AI configuration for job not found");
  }

  if (!aiConfig.cvSimilarity) {
    throw new ValidationError("This feature was not configured for this job");
  }

  // Get CV similarity score
  const rows: Array<{ similarity_score: number }> = await AppDataSource.query(
    `
    WITH jd_cte AS (
      SELECT job_embedding::vector FROM jobs WHERE id = $1
    ),
    talent_cte AS (
      SELECT cv_embedding::vector FROM talent_embeddings WHERE user_id = $2 LIMIT 1
    )
    SELECT ABS((SELECT job_embedding::vector FROM jd_cte) <=> (SELECT cv_embedding::vector FROM talent_cte)) AS similarity_score
    `,
    [jobId, userId]
  );
  const rawScore = rows[0]?.similarity_score ?? 0;
  const cvSimilarityScore = convertSimilarityToPercentage(rawScore);

  application.cvSimilarityScore = cvSimilarityScore;
  application.cvSimilarityAttempts = (application.cvSimilarityAttempts ?? 0) + 1;

  const minScore = aiConfig.minCvSimilarityScore ?? 0;
  const MAX_ATTEMPTS = 2; // 1 initial + 1 retry
  const passed = cvSimilarityScore >= minScore;
  const attemptsExhausted = application.cvSimilarityAttempts >= MAX_ATTEMPTS;

  if (passed || attemptsExhausted) {
    const user = await userRepo().findOne({ where: { id: userId } });
    if (user) {
      application = await processNextStage(
        user,
        application,
        ScreeningStage.CvSimilarity,
        aiConfig
      );
    }
  } else {
    application.currentStage = ScreeningStage.CvSimilarity;
    application.status = ApplicationStatus.RetakeAssessment;
  }

  application = await applicationRepo().save(application);
  return { cvSimilarityScore, application };
};

export interface JobApplicationsParams {
  jobId: string;
  applicationType?: ApplicationType;
  applicationStatus?: ApplicationStatus;
  minCvSimilarityScore?: string | number;
  minPersonalizedScore?: string | number;
  experience?: string;
  maxSalary?: string | number;
  offset?: number | string;
  limit?: number | string;
}

export interface JobApplicationsResult {
  applications: Application[];
  aiConfig: { minCvSimilarityScore: number | null; minPrescreeningScore: number | null } | null;
}

export const jobApplications = async (
  userId: string,
  payload: JobApplicationsParams
): Promise<JobApplicationsResult> => {
  const { jobId } = payload;

  const job = await jobRepo().findOne({ where: { id: jobId }, relations: { aiConfig: true } });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  if (job.postedById !== userId) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }

  const qb = applicationRepo()
    .createQueryBuilder("application")
    .leftJoinAndSelect("application.talent", "talent")
    .where("application.job_id = :jobId", { jobId });

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

  if (payload.experience) {
    qb.andWhere("talent.experience = :experience", { experience: payload.experience });
  }

  if (payload.maxSalary) {
    qb.andWhere("talent.maxSalary <= :maxSalary", { maxSalary: Number(payload.maxSalary) });
  }

  const offset = Number(payload.offset) || 0;
  const limit = Math.min(Number(payload.limit) || 50, MAX_PAGE_SIZE);

  const applications = await qb
    .orderBy("application.cvSimilarityScore", "DESC")
    .addOrderBy("application.personalizedScore", "DESC")
    .addOrderBy("application.createdAt", "DESC")
    .skip(offset)
    .take(limit)
    .getMany();

  const recommendations = await loadRecommendationsByApplicationIds(applications.map((a) => a.id));
  return {
    applications: applications.map((application) =>
      overlayVerdictFromRecommendation(application, recommendations.get(application.id))
    ),
    aiConfig: job.aiConfig
      ? {
          minCvSimilarityScore: job.aiConfig.minCvSimilarityScore,
          minPrescreeningScore: job.aiConfig.minPrescreeningScore,
        }
      : null,
  };
};

export interface RetryVerdictsResult {
  attempted: number;
  succeeded: number;
  failed: number;
}

export const retryMissingVerdicts = async (
  userId: string,
  jobId: string
): Promise<RetryVerdictsResult> => {
  const job = await jobRepo().findOne({ where: { id: jobId } });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  if (job.postedById !== userId) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }

  const applications = await applicationRepo().find({
    where: { jobId, currentStage: ScreeningStage.Completed, matchVerdict: IsNull() },
    relations: { talent: true },
  });

  await Promise.all(
    applications.map((application) =>
      triggerMatchVerdict(application.talent, application, { force: true })
    )
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
}

export const apply = async (user: User, payload: ApplyPayload): Promise<Application> => {
  const { jobId } = payload;

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
    stages,
    recruiterId: job.postedById,
    currentStage: entryStage as Application["currentStage"],
    status: ApplicationStatus.Pending,
  });

  const saved = await applicationRepo().save(application);

  // Increment noOfApplicants
  await jobRepo()
    .createQueryBuilder()
    .update(Job)
    .set({ noOfApplicants: () => '"noOfApplicants" + 1' })
    .where("id = :id", { id: jobId })
    .execute();

  return saved;
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

  const scout = await scoutRepo().findOne({ where: { id: scoutId } });
  if (!scout) {
    throw new NotFoundError("Scout report not found");
  }
  if (scout.recruiterId !== userId) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }

  const job = await jobRepo().findOne({
    where: { id: jobId },
    relations: { aiConfig: true },
  });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  if (job.postedById !== userId) {
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

  if (application.currentStage !== ScreeningStage.Prescreening) {
    return application;
  }

  const user = await userRepo().findOne({ where: { id: userId } });
  if (
    !user ||
    user.prescreeningScore === null ||
    user.prescreeningScore === undefined ||
    !isPrescreeningScoreValid(user.prescreeningScoredAt)
  ) {
    return application;
  }

  const job = await jobRepo().findOne({ where: { id: jobId }, relations: { aiConfig: true } });
  const minScore = job?.aiConfig?.minPrescreeningScore ?? 0;

  let updated: Application;
  if (user.prescreeningScore < minScore) {
    application.status = ApplicationStatus.RetakeAssessment;
    application.assessmentRetryDate = getAssessmentRetryDate();
    updated = application;
  } else {
    updated = await processNextStage(
      user,
      application,
      ScreeningStage.Prescreening,
      job?.aiConfig ?? null
    );
  }

  return applicationRepo().save(updated);
};
