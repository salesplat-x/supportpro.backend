import { AppDataSource } from "../database/dataSource.js";
import { Plan } from "../entities/Plan.js";
import { NotFoundError, ConflictError, ValidationError } from "../utils/errors/index.js";
import {
  generatePlanObject,
  createPlan as paystackCreatePlan,
  updatePlan as paystackUpdatePlan,
  IPlanUpdateConfig,
} from "../utils/integrations/paystack.js";
import { BillingInterval, Currency } from "../types/enums.js";

function planRepo() {
  return AppDataSource.getRepository(Plan);
}

export interface PlanPayload {
  name: string;
  amount: number;
  interval: BillingInterval;
  currency: Currency;
  description: string;
  features?: string[] | null;
}

export const create = async (payload: PlanPayload): Promise<Plan> => {
  const existingPlan = await planRepo().findOne({
    where: {
      name: payload.name,
      interval: payload.interval,
      currency: payload.currency,
    },
  });
  if (existingPlan) {
    throw new ConflictError("Plan already exists");
  }

  const { monthlyAmount, ...paystackConfig } = generatePlanObject(payload as Plan);
  const planResponse = await paystackCreatePlan(paystackConfig);

  const plan = planRepo().create({
    ...paystackConfig,
    amount: monthlyAmount!,
    paystackAmount: paystackConfig.amount,
    features: payload.features ?? null,
    paystackPlanCode: planResponse.data.plan_code,
    currency: payload.currency,
  } as unknown as Plan);

  return planRepo().save(plan);
};

export const fetch = async (payload: { currency?: string; interval?: string }): Promise<Plan[]> => {
  const qb = planRepo().createQueryBuilder("plan").where("plan.isDeleted = false");

  if (payload.currency) {
    qb.andWhere("plan.currency = :currency", { currency: payload.currency });
  }
  if (payload.interval) {
    qb.andWhere("plan.interval = :interval", { interval: payload.interval });
  }

  return qb.getMany();
};

export const fetchOne = async (planId: string): Promise<Plan> => {
  const plan = await planRepo().findOne({ where: { id: planId } });
  if (!plan || plan.isDeleted) {
    throw new NotFoundError("Plan not found or deleted");
  }
  return plan;
};

export const update = async (
  planId: string,
  payload: Partial<IPlanUpdateConfig>
): Promise<Plan> => {
  const plan = await planRepo().findOne({ where: { id: planId } });
  if (!plan || plan.isDeleted) {
    throw new NotFoundError("Plan not found or deleted");
  }

  if (payload.name) {
    const name = payload.name.toLowerCase();
    const existing = await planRepo().findOne({ where: { name } });
    if (existing && existing.id !== plan.id) {
      throw new ConflictError("A plan already exists with this name");
    }
    payload.name = name;
  }

  const planCode = plan.paystackPlanCode ?? "";
  await paystackUpdatePlan(planCode, payload);

  const updated = await planRepo().save({ ...plan, ...(payload as Partial<Plan>) });
  return updated;
};

export const deleteItem = async (planId: string): Promise<void> => {
  const plan = await planRepo().findOne({ where: { id: planId } });
  if (!plan) {
    throw new NotFoundError("Plan not found");
  }
  await planRepo().save({ ...plan, isDeleted: true });
};
