import { AppDataSource } from "../database/dataSource.js";
import { Job } from "../entities/Job.js";
import { Role } from "../entities/Role.js";
import { AIConfig } from "../entities/AIConfig.js";
import { Application } from "../entities/Application.js";
import { User } from "../entities/User.js";
import { Notification } from "../entities/Notification.js";
import { NotFoundError, AuthorizationError, ValidationError } from "../utils/errors/index.js";
import {
  UserRole,
  JobStatus,
  WorkMode,
  ApplicationType,
  ApplicationStatus,
  ScreeningStage,
} from "../types/enums.js";
import { createEmbedding } from "../utils/integrations/openai.js";
import { convertSimilarityToPercentage, preprocessText, sortDirection } from "../utils/text.js";

const jobRepo = () => AppDataSource.getRepository(Job);

const roleRepo = () => AppDataSource.getRepository(Role);

const aiConfigRepo = () => AppDataSource.getRepository(AIConfig);

const applicationRepo = () => AppDataSource.getRepository(Application);

const userRepo = () => AppDataSource.getRepository(User);

const notificationRepo = () => AppDataSource.getRepository(Notification);

export interface CreateJobPayload {
  role?: string;
  aiConfigId?: string | null;
  jobBrief: string;
  maxSalary: number;
  minSalary: number;
  experienceLevel: string;
  locationCity?: string | null;
  locationState: string;
  locationCountry: string;
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
    roleId,
    postedById: userId,
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

  if (update.role) {
    const existingRole = await roleRepo().findOne({ where: { id: update.role } });
    if (!existingRole) {
      throw new NotFoundError("Role does not exist");
    }
    (update as Record<string, unknown>)["roleId"] = existingRole.id;
    delete (update as Record<string, unknown>)["role"];
  }

  // Notify applicants when job status changes
  if (update.status && update.status !== existingJob.status) {
    const applications = await applicationRepo().find({
      where: { jobId: id },
    });

    const notifications = applications
      .filter(
        (app) =>
          app.status !== ApplicationStatus.Shortlisted && app.status !== ApplicationStatus.Rejected
      )
      .map((app) =>
        notificationRepo().create({
          userId: app.talentId,
          message: `Applications for this job has been ${update.status}`,
        })
      );

    if (notifications.length > 0) {
      await notificationRepo().save(notifications);
    }
  }

  // Exclude 'role' string field to avoid type conflict with Role entity
  const { role: _role2, ...updateData } = update;
  const updated = await jobRepo().save({ ...existingJob, ...updateData });
  return updated;
};

export const fetchAllJobs = async (payload: FetchJobsParams): Promise<Job[]> => {
  const qb = jobRepo()
    .createQueryBuilder("job")
    .leftJoinAndSelect("job.role", "role")
    .leftJoinAndSelect("job.postedBy", "postedBy");

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

  const limit = Number(payload.limit) || 50;
  const offset = Number(payload.offset) || 0;
  const order = sortDirection(payload.sort ?? "desc");

  return qb.orderBy("job.createdAt", order).skip(offset).take(limit).getMany();
};

export const fetchJob = async (jobId: string): Promise<Job> => {
  const job = await jobRepo().findOne({
    where: { id: jobId },
    relations: { role: true, postedBy: true, aiConfig: true },
  });
  if (!job) {
    throw new NotFoundError("Job not found");
  }
  return job;
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
    .andWhere("user.experience = :exp", { exp: job.experienceLevel })
    .andWhere("user.maxSalary <= :maxSalary", { maxSalary: job.maxSalary });

  if (payload.incomplete !== "true") {
    qb.andWhere("user.prescreeningScore IS NOT NULL");
  }

  return qb.orderBy("user.prescreeningScore", "DESC").getMany();
};

export const topTalents = async (
  userId: string,
  userRole: UserRole,
  payload: TopTalentsParams
): Promise<{ talents: User[]; newApplicants: number }> => {
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

  const limit = payload.limit ?? aiConfig.noOfCvSimilarCandidates ?? 20;
  const percentage = payload.percentage ?? aiConfig.minCvSimilarityScore ?? 50;
  const strictness = (100 - percentage) / 100;

  // Get top CV embeddings via pgvector
  const res: Array<{ user_id: string; similarity: number }> = await AppDataSource.query(
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
  const talents =
    talentIds.length > 0
      ? await userRepo()
          .createQueryBuilder("user")
          .whereInIds(talentIds)
          .leftJoinAndSelect("user.userRoles", "userRoles")
          .getMany()
      : [];

  return { talents, newApplicants };
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

  const stages = aiConfig.stages ?? {};
  const minScore = aiConfig.minCvSimilarityScore ?? 0;

  if (cvSimilarityScore < minScore) {
    application.currentStage = ScreeningStage.CvSimilarity;
    application.status = ApplicationStatus.RetakeAssessment;
    application.assessmentRetryDate = getAssessmentRetryDate();
  } else {
    // Process next stage
    const nextStage = stages[ScreeningStage.CvSimilarity];
    if (nextStage) {
      application.currentStage = nextStage as Application["currentStage"];
      if (nextStage === ScreeningStage.Completed) {
        application.status = ApplicationStatus.Shortlisted;
      } else {
        application.status = ApplicationStatus.Pending;
      }
    }
  }

  application = await applicationRepo().save(application);
  return { cvSimilarityScore, application };
};

const getAssessmentRetryDate = (days = 7): Date => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
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

export const jobApplications = async (
  userId: string,
  payload: JobApplicationsParams
): Promise<Application[]> => {
  const { jobId } = payload;

  const job = await jobRepo().findOne({ where: { id: jobId } });
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
  const limit = Number(payload.limit) || 50;

  return qb
    .orderBy("application.cvSimilarityScore", "DESC")
    .addOrderBy("application.personalizedScore", "DESC")
    .addOrderBy("application.createdAt", "DESC")
    .skip(offset)
    .take(limit)
    .getMany();
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

  // Use explicit null/undefined check — score of 0 is a valid result and must not block application
  if (user.prescreeningScore === null || user.prescreeningScore === undefined) {
    throw new ValidationError(
      "You have to take the prescreening test before you can apply for a job"
    );
  }

  if (user.prescreeningScore < (aiConfig.minPrescreeningScore ?? 0)) {
    throw new AuthorizationError("Sorry your prescreening score is too low to proceed");
  }

  const stages = aiConfig.stages ?? {};
  // First stage after prescreening
  const firstNextStage = stages[ScreeningStage.Prescreening] ?? ScreeningStage.Prescreening;

  const application = applicationRepo().create({
    talentId: user.id,
    jobId,
    applicationType: ApplicationType.Application,
    stages: aiConfig.stages,
    recruiterId: job.postedById,
    currentStage: firstNextStage as Application["currentStage"],
    status: ApplicationStatus.Pending,
  });

  const saved = await applicationRepo().save(application);

  // Increment noOfApplicants
  await jobRepo()
    .createQueryBuilder()
    .update(Job)
    .set({ noOfApplicants: () => '"noOfApplicants" + 1' })
    .where('id = :id', { id: jobId })
    .execute();

  return saved;
};
