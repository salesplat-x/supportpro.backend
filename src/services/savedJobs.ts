import { In } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Job, SavedJob } from "../entities";
import { JobStatus } from "../types/enums.js";
import { NotFoundError, ValidationError } from "../utils/errors";

const savedJobRepo = () => AppDataSource.getRepository(SavedJob);

const LISTED: JobStatus[] = [JobStatus.Active, JobStatus.Closed, JobStatus.Suspended];

export const saveJob = async (userId: string, jobId: string): Promise<{ saved: true }> => {
  const job = await AppDataSource.getRepository(Job).findOne({
    where: { id: jobId },
    select: { id: true, status: true },
  });
  if (!job || !LISTED.includes(job.status)) {
    throw new NotFoundError("Job not found");
  }
  if (job.status !== JobStatus.Active) {
    throw new ValidationError("This job is no longer taking applications, so it can't be saved");
  }
  await savedJobRepo()
    .createQueryBuilder()
    .insert()
    .into(SavedJob)
    .values({ userId, jobId })
    .orIgnore()
    .execute();
  return { saved: true };
};

export const unsaveJob = async (userId: string, jobId: string): Promise<{ saved: false }> => {
  await savedJobRepo().delete({ userId, jobId });
  return { saved: false };
};

export const savedJobIds = async (userId: string, jobIds: string[]): Promise<Set<string>> => {
  if (jobIds.length === 0) return new Set();
  const rows = await savedJobRepo().find({
    where: { userId, jobId: In(jobIds) },
    select: { jobId: true },
  });
  return new Set(rows.map((row) => row.jobId));
};
