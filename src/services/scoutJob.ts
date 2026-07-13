import { AppDataSource } from "../database/dataSource.js";
import { ScoutJob } from "../entities/ScoutJob.js";
import { Role } from "../entities/Role.js";
import { NotFoundError, AuthorizationError, ValidationError } from "../utils/errors";
import { createEmbedding } from "../utils/integrations/openai.js";
import { preprocessText } from "../utils/text.js";

const scoutJobRepo = () => AppDataSource.getRepository(ScoutJob);

const roleRepo = () => AppDataSource.getRepository(Role);

export interface CreateScoutJobPayload {
  roleId: string;
  jobBrief: string;
  name: string;
  recruiterGuide: string;
}

export interface UpdateScoutJobPayload {
  id: string;
  roleId?: string;
  jobBrief?: string;
  name?: string;
  recruiterGuide?: string;
}

export const createJob = async (
  userId: string,
  payload: CreateScoutJobPayload
): Promise<ScoutJob> => {
  const existingRole = await roleRepo().findOne({ where: { id: payload.roleId } });
  if (!existingRole) {
    throw new NotFoundError("Role does not exist");
  }

  // Create embedding for job description
  const jd = preprocessText(`${payload.jobBrief} \n ${payload.recruiterGuide}`);
  const jobEmbedding = await createEmbedding(jd);
  if (!jobEmbedding || !jobEmbedding[0]?.embedding) {
    throw new ValidationError("Unable to create vector embedding for JD");
  }

  const scoutJob = scoutJobRepo().create({
    ...payload,
    postedById: userId,
  });

  const saved = await scoutJobRepo().save(scoutJob);

  // Store embedding directly on the ScoutJob entity column
  const embeddingStr = `[${jobEmbedding[0]!.embedding.toString()}]`;
  await scoutJobRepo()
    .createQueryBuilder()
    .update(ScoutJob)
    .set({ jobEmbedding: embeddingStr })
    .where("id = :id", { id: saved.id })
    .execute();

  return saved;
};

export const updateJob = async (
  userId: string,
  payload: UpdateScoutJobPayload
): Promise<ScoutJob> => {
  const { id, ...update } = payload;

  const existingJob = await scoutJobRepo().findOne({
    where: { id },
    relations: { postedBy: true },
  });
  if (!existingJob) {
    throw new NotFoundError("Job does not exist");
  }

  if (existingJob.postedById !== userId) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }

  if (update.roleId) {
    const existingRole = await roleRepo().findOne({ where: { id: update.roleId } });
    if (!existingRole) {
      throw new NotFoundError("Role does not exist");
    }
  }

  const updated = await scoutJobRepo().save({ ...existingJob, ...update });
  return updated;
};

export const fetchJob = async (scoutJobId: string): Promise<ScoutJob> => {
  const scoutJob = await scoutJobRepo().findOne({
    where: { id: scoutJobId },
    relations: { role: true, postedBy: true },
  });
  if (!scoutJob) {
    throw new NotFoundError("Job not found");
  }
  return scoutJob;
};
