import { AppDataSource } from "../database/dataSource.js";
import { CommissionPlan, type CommissionTier } from "../entities/CommissionPlan.js";
import { ConflictError, NotFoundError } from "../utils/errors";
import { assertOwner } from "./peopleAccess.js";
import { isUniqueViolation } from "./staffRecord.js";

export interface CommissionPlanInput {
  name: string;
  tiers: CommissionTier[];
}

const FOREIGN_KEY_VIOLATION = "23503";

const isForeignKeyViolation = (err: unknown): boolean => {
  const candidate = err as { code?: string; driverError?: { code?: string } } | null;
  return (
    candidate?.code === FOREIGN_KEY_VIOLATION ||
    candidate?.driverError?.code === FOREIGN_KEY_VIOLATION
  );
};

const repo = () => AppDataSource.getRepository(CommissionPlan);

const savePlan = async (plan: CommissionPlan): Promise<CommissionPlan> => {
  try {
    return await repo().save(plan);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError("Your company already has a plan with this name");
    }
    throw err;
  }
};

export const findPlan = async (organizationId: string, planId: string): Promise<CommissionPlan> => {
  const plan = await repo().findOne({ where: { id: planId, organizationId } });
  if (!plan) {
    throw new NotFoundError("Commission plan not found");
  }
  return plan;
};

export const listPlans = async (
  userId: string,
  organizationId: string
): Promise<CommissionPlan[]> => {
  await assertOwner(userId, organizationId);
  return repo().find({ where: { organizationId }, order: { name: "ASC" } });
};

export const createPlan = async (
  userId: string,
  organizationId: string,
  input: CommissionPlanInput
): Promise<CommissionPlan> => {
  await assertOwner(userId, organizationId);
  return savePlan(repo().create({ organizationId, ...input }));
};

export const updatePlan = async (
  userId: string,
  organizationId: string,
  planId: string,
  input: CommissionPlanInput
): Promise<CommissionPlan> => {
  await assertOwner(userId, organizationId);
  const plan = await findPlan(organizationId, planId);
  return savePlan(Object.assign(plan, input));
};

export const deletePlan = async (
  userId: string,
  organizationId: string,
  planId: string
): Promise<void> => {
  await assertOwner(userId, organizationId);
  const plan = await findPlan(organizationId, planId);
  try {
    await repo().delete(plan.id);
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw new ConflictError("This plan is given to someone. Remove it from their pay first.");
    }
    throw err;
  }
};
