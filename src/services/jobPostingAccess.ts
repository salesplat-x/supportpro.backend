import { AppDataSource } from "../database/dataSource.js";
import { Job } from "../entities/Job.js";
import { getActiveOrganizationId } from "./organizationScope.js";

export const isPostingCompanyMember = async (userId: string, jobId: string): Promise<boolean> => {
  const job = await AppDataSource.getRepository(Job).findOne({
    where: { id: jobId },
    select: { id: true, organizationId: true, postedById: true },
  });
  if (!job) return false;
  if (job.organizationId) {
    return (await getActiveOrganizationId(userId)) === job.organizationId;
  }
  return job.postedById === userId;
};
