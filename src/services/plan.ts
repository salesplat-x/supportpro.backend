import { AppDataSource } from "../database/dataSource.js";
import { Plan } from "../entities";
import { ConflictError, NotFoundError } from "../utils/errors";
import {
  createPlan as paystackCreatePlan,
  generatePlanObject,
  IPlanUpdateConfig,
  updatePlan as paystackUpdatePlan,
} from "../utils/integrations/paystack.js";
import { BillingInterval, Currency } from "../types/enums.js";

const planRepo = () => AppDataSource.getRepository(Plan);

export interface PlanPayload {
  planKey: string;
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
      planKey: payload.planKey,
      interval: payload.interval,
      isDeleted: false,
    },
  });
  if (existingPlan) {
    throw new ConflictError("Plan already exists");
  }

  const { monthlyAmount, ...paystackConfig } = generatePlanObject(payload as Plan);
  const planResponse = await paystackCreatePlan(paystackConfig);

  const plan = planRepo().create({
    ...paystackConfig,
    planKey: payload.planKey,
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
  payload: Partial<IPlanUpdateConfig> & { planKey?: string }
): Promise<Plan> => {
  const plan = await planRepo().findOne({ where: { id: planId } });
  if (!plan || plan.isDeleted) {
    throw new NotFoundError("Plan not found or deleted");
  }

  if (payload.planKey || payload.interval) {
    const nextPlanKey = payload.planKey ?? plan.planKey;
    const nextInterval = (payload.interval as BillingInterval | undefined) ?? plan.interval;
    const existing = await planRepo().findOne({
      where: { planKey: nextPlanKey, interval: nextInterval, isDeleted: false },
    });
    if (existing && existing.id !== plan.id) {
      throw new ConflictError("A plan already exists for this key and interval");
    }
  }

  const planCode = plan.paystackPlanCode ?? "";
  await paystackUpdatePlan(planCode, payload);

  return await planRepo().save({ ...plan, ...(payload as Partial<Plan>) });
};

export const deleteItem = async (planId: string): Promise<void> => {
  const plan = await planRepo().findOne({ where: { id: planId } });
  if (!plan) {
    throw new NotFoundError("Plan not found");
  }
  await planRepo().save({ ...plan, isDeleted: true });
};
