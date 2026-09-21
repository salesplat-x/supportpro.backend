import { AppDataSource } from "../database/dataSource.js";
import { Plan } from "../entities/Plan.js";
import { getSubscriptionPlans } from "../config/pricingCatalog.js";
import { BillingInterval, Currency } from "../types/enums.js";
import {
  createPlan as paystackCreatePlan,
  generatePlanObject,
  isDummyPaystack,
} from "../utils/integrations/paystack.js";
import * as planService from "./plan.js";
import env from "../config/env.js";
import logger from "../utils/logger.js";

const planRepo = () => AppDataSource.getRepository(Plan);

/**
 * Upserts one `Plan` DB row per (subscription plan, interval) from the catalogue,
 * creating a real Paystack plan (and persisting its plan code) for any that don't
 * exist yet. Pay per Use is excluded — it has no recurring Paystack plan (§6).
 *
 * Idempotent and safe to re-run: existing rows with a matching amount are left
 * alone; existing rows missing a Paystack code get one backfilled. A price drift
 * between an existing row and the catalogue is logged, never silently applied —
 * repricing a plan with live subscribers must be a deliberate, separate operation.
 */
export const syncPlansFromCatalog = async (): Promise<Map<string, Plan>> => {
  if (env.app_env === "production" && isDummyPaystack()) {
    throw new Error(
      "Refusing to sync plans in production while PAYSTACK_MODE=dummy — this would write unusable dummy plan codes."
    );
  }

  const result = new Map<string, Plan>();

  for (const plan of getSubscriptionPlans()) {
    for (const interval of [BillingInterval.Monthly, BillingInterval.Annually]) {
      const amount = interval === BillingInterval.Annually
        ? Math.round((plan.yearlyAmountNgn ?? 0) / 12)
        : plan.monthlyAmountNgn;

      const existing = await planRepo().findOne({
        where: { planKey: plan.key, interval, isDeleted: false },
      });

      if (existing) {
        if (existing.amount !== amount) {
          logger.warn(
            `Plan ${plan.key}/${interval} amount drift: DB has ${existing.amount}, catalogue has ${amount}. Not auto-applied — reprice deliberately.`
          );
        }
        if (!existing.paystackPlanCode) {
          // Backfill a missing Paystack code on an already-existing row — can't go
          // through planService.create() here, since it would reject this as a duplicate.
          const { monthlyAmount: _monthlyAmount, ...paystackConfig } = generatePlanObject(existing);
          const planResponse = await paystackCreatePlan(paystackConfig);
          const updated = await planRepo().save({
            ...existing,
            paystackPlanCode: planResponse.data.plan_code,
          });
          result.set(`${plan.key}:${interval}`, updated);
        } else {
          result.set(`${plan.key}:${interval}`, existing);
        }
        continue;
      }

      const created = await planService.create({
        planKey: plan.key,
        name: `${plan.name} (${interval})`,
        amount,
        interval,
        currency: Currency.NGN,
        description: plan.description,
        features: plan.features.map((feature) => feature.label ?? feature.text ?? "").filter(Boolean),
      });
      result.set(`${plan.key}:${interval}`, created);
    }
  }

  return result;
};
