import { AppDataSource } from "../database/dataSource.js";
import {
  CommissionPlan,
  type CommissionBand,
  type CommissionFrequency,
  type CommissionPaidOn,
} from "../entities/CommissionPlan.js";
import { ConflictError, NotFoundError } from "../utils/errors";
import { assertOwner } from "./peopleAccess.js";
import { isUniqueViolation } from "./staffRecord.js";

export interface CommissionPlanInput {
  name: string;
  paidOn: CommissionPaidOn;
  frequency: CommissionFrequency;
  bands: CommissionBand[];
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

export interface CommissionPlanView {
  id: string;
  name: string;
  paidOn: CommissionPaidOn | null;
  frequency: CommissionFrequency | null;
  bands: CommissionBand[] | null;
  needsBands: boolean;
  peopleCount: number;
  people: string[];
}

const PEOPLE_SHOWN = 2;

/** Current package per person: the latest one already started, else the earliest upcoming one. */
const PLAN_PEOPLE_SQL = `
  WITH current_pay AS (
    SELECT DISTINCT ON (p.staff_id) p.commission_plan_id, s.full_name
    FROM pay_packages p
    JOIN staff_members s ON s.id = p.staff_id
    WHERE s.organization_id = $1 AND s.status <> 'ended'
    ORDER BY p.staff_id,
      p.starts_on <= $2 DESC,
      CASE WHEN p.starts_on <= $2 THEN p.starts_on END DESC,
      p.starts_on ASC
  )
  SELECT commission_plan_id, COUNT(*) AS people,
    (ARRAY_AGG(full_name ORDER BY full_name))[1:${PEOPLE_SHOWN}] AS names
  FROM current_pay
  WHERE commission_plan_id IS NOT NULL
  GROUP BY commission_plan_id
`;

export const listPlans = async (
  userId: string,
  organizationId: string
): Promise<CommissionPlanView[]> => {
  await assertOwner(userId, organizationId);
  const [plans, counts] = await Promise.all([
    repo().find({ where: { organizationId }, order: { name: "ASC" } }),
    AppDataSource.query(PLAN_PEOPLE_SQL, [
      organizationId,
      new Date().toISOString().slice(0, 10),
    ]) as Promise<{ commission_plan_id: string; people: string; names: string[] }[]>,
  ]);
  const people = new Map(counts.map((row) => [row.commission_plan_id, row]));
  return plans.map((plan) => {
    const row = people.get(plan.id);
    return {
      id: plan.id,
      name: plan.name,
      paidOn: plan.paidOn,
      frequency: plan.frequency,
      bands: plan.bands,
      needsBands: plan.bands === null,
      peopleCount: row ? Number(row.people) : 0,
      people: row?.names ?? [],
    };
  });
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
