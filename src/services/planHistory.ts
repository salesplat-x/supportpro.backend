import { AppDataSource } from "../database/dataSource.js";
import { OrganizationPlanHistory } from "../entities/OrganizationPlanHistory.js";

const PLAN_HISTORY_LIMIT = 100;

export const getOrganizationPlanHistory = async (
  organizationId: string
): Promise<OrganizationPlanHistory[]> =>
  AppDataSource.getRepository(OrganizationPlanHistory).find({
    where: { organizationId },
    order: { createdAt: "DESC" },
    take: PLAN_HISTORY_LIMIT,
  });
