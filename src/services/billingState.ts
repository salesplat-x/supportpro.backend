import { EntityManager } from "typeorm";

import { AppDataSource } from "../database/dataSource.js";
import { FeatureUsageCounter } from "../entities/FeatureUsageCounter.js";
import { Organization } from "../entities/Organization.js";
import { OrganizationPlanHistory } from "../entities/OrganizationPlanHistory.js";
import {
  BillingInterval,
  BillingStatus,
  DEFAULT_BILLING_PLAN_KEY,
  PlanChangeReason,
  SubscriptionStatus,
} from "../types/enums.js";

/**
 * The single writer for organizations.billing_*. Billing lives on the organization and is
 * shared by every member, so a half-applied plan change is a billing bug — every write here
 * sets all four columns together. Every plan change is also written to the plan history and
 * zeroes the current period's usage, in the same transaction, so a new plan never inherits the
 * old plan's consumption.
 *
 * Deliberately a leaf module (dataSource + entities + enums only): payment.ts already imports
 * entitlements.ts, so hanging these writers off entitlements.ts would create a cycle as soon
 * as the expiry guard needs the Subscription table.
 */

const PAY_AS_YOU_GO_KEYS = [DEFAULT_BILLING_PLAN_KEY];

export type BillingState = {
  billingPlan: string;
  billingInterval: BillingInterval | null;
  billingStatus: BillingStatus;
  billingPeriodEnd: Date | null;
};

export type PlanChange = {
  reason: PlanChangeReason;
  paymentId?: string | null;
};

export const currentPeriodStart = (): string => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
};

/** Zero monthly meters for the current calendar period after a plan change or renewal. */
export const resetPeriodUsage = async (
  organizationId: string,
  manager?: EntityManager
): Promise<void> => {
  const m = manager ?? AppDataSource.manager;
  await m
    .createQueryBuilder()
    .update(FeatureUsageCounter)
    .set({ count: 0 })
    .where(`"organization_id" = :organizationId`, { organizationId })
    .andWhere(`"period_start" = :periodStart`, { periodStart: currentPeriodStart() })
    .execute();
};

const recordPlanChange = async (
  m: EntityManager,
  organizationId: string,
  fromPlan: string | null,
  toPlan: string,
  billingInterval: BillingInterval | null,
  change: PlanChange
): Promise<void> => {
  await m.insert(OrganizationPlanHistory, {
    organizationId,
    fromPlan,
    toPlan,
    billingInterval,
    reason: change.reason,
    paymentId: change.paymentId ?? null,
  });
  await resetPeriodUsage(organizationId, m);
};

export const computeBillingPeriodEnd = (
  from: Date,
  interval: BillingInterval | null | undefined
): Date => {
  const end = new Date(from);
  if (interval === BillingInterval.Annually) {
    end.setUTCFullYear(end.getUTCFullYear() + 1);
  } else {
    end.setUTCMonth(end.getUTCMonth() + 1);
  }
  return end;
};

/**
 * Applies a complete billing state under a pessimistic write lock on the organization row.
 * Joins the caller's transaction when a manager is passed (a lock needs one), opens its own
 * otherwise. Returns null when the organization no longer exists. A same-plan write (renewal,
 * interval change) is not a plan change and leaves history and usage alone.
 */
export const setOrganizationBilling = async (
  organizationId: string,
  state: BillingState,
  change: PlanChange,
  manager?: EntityManager
): Promise<Organization | null> => {
  const run = async (m: EntityManager): Promise<Organization | null> => {
    const organization = await m.findOne(Organization, {
      where: { id: organizationId },
      lock: { mode: "pessimistic_write" },
    });
    if (!organization) return null;

    const previousPlan = organization.billingPlan;
    organization.billingPlan = state.billingPlan;
    organization.billingInterval = state.billingInterval;
    organization.billingStatus = state.billingStatus;
    organization.billingPeriodEnd = state.billingPeriodEnd;
    const saved = await m.save(organization);

    if (previousPlan !== state.billingPlan) {
      await recordPlanChange(
        m,
        organizationId,
        previousPlan,
        state.billingPlan,
        state.billingInterval,
        change
      );
    }
    return saved;
  };

  return manager ? run(manager) : AppDataSource.manager.transaction(run);
};

/**
 * Dunning only — a failed invoice flags the account without taking the plan away, so this
 * must never touch plan/interval/periodEnd. No-ops for organizations already on pay per use.
 */
export const setOrganizationBillingStatus = async (
  organizationId: string,
  status: BillingStatus,
  manager?: EntityManager
): Promise<void> => {
  const m = manager ?? AppDataSource.manager;
  await m
    .createQueryBuilder()
    .update(Organization)
    .set({ billingStatus: status })
    .where(`"id" = :organizationId`, { organizationId })
    .andWhere(`"billing_plan" NOT IN (:...payAsYouGo)`, {
      payAsYouGo: PAY_AS_YOU_GO_KEYS,
    })
    .execute();
};

/**
 * Moves the organization to pay per use in one statement, but only while `conditions` still
 * hold at the moment of the write. The previous plan is read under the same row lock so the
 * history row names what was actually replaced.
 */
const revertToPayPerUse = async (
  organizationId: string,
  conditions: string,
  params: unknown[],
  reason: PlanChangeReason,
  manager?: EntityManager
): Promise<boolean> => {
  const run = async (m: EntityManager): Promise<boolean> => {
    const [rows]: [Array<{ from_plan: string }>, number] = await m.query(
      `UPDATE "organizations" o
            SET "billing_plan" = $2,
                "billing_interval" = NULL,
                "billing_status" = $3::"public"."users_billingstatus_enum",
                "billing_period_end" = NULL,
                "updatedAt" = now()
           FROM (
             SELECT "id", "billing_plan"
               FROM "organizations"
              WHERE "id" = $1
                FOR UPDATE
           ) previous
          WHERE o."id" = previous."id"
            AND ${conditions}
      RETURNING previous."billing_plan" AS from_plan`,
      [organizationId, DEFAULT_BILLING_PLAN_KEY, BillingStatus.Cancelled, ...params]
    );
    const reverted = rows[0];
    if (!reverted) return false;

    await recordPlanChange(m, organizationId, reverted.from_plan, DEFAULT_BILLING_PLAN_KEY, null, {
      reason,
    });
    return true;
  };

  return manager ? run(manager) : AppDataSource.manager.transaction(run);
};

/**
 * Reverts to pay per use only while the organization is still on the plan the caller saw, so
 * an upgrade that lands mid-flight makes this a no-op instead of wiping the plan the customer
 * just paid for.
 */
export const revertToPayPerUseIfStillOnPlan = async (
  organizationId: string,
  expectedPlanKey: string,
  manager?: EntityManager
): Promise<boolean> =>
  revertToPayPerUse(
    organizationId,
    `o."billing_plan" = $4 AND o."billing_plan" <> $2`,
    [expectedPlanKey],
    PlanChangeReason.SubscriptionDisabled,
    manager
  );

/**
 * Reverts to pay per use only if the paid period is still past at the moment of the write
 * and no live subscription contradicts it. The expiry re-check and the subscription guard
 * are both in SQL so a concurrent renewal or upgrade cannot lose the race. "Now" is bound from
 * JS rather than SQL now(): these timestamp columns are written through the driver in the
 * process's local time, so comparing them with the database clock is off by the UTC offset.
 */
export const revertToPayPerUseIfExpired = async (
  organizationId: string,
  manager?: EntityManager
): Promise<boolean> =>
  revertToPayPerUse(
    organizationId,
    `o."billing_plan" <> ALL($4::varchar[])
     AND o."billing_period_end" IS NOT NULL
     AND o."billing_period_end" <= $6::timestamp
     AND NOT EXISTS (
       SELECT 1 FROM "subscriptions" s
        WHERE s."organization_id" = o."id"
          AND s."status" = $5
          AND COALESCE(s."nextPaymentDate", s."expiryDate") > $6::timestamp
     )`,
    [PAY_AS_YOU_GO_KEYS, SubscriptionStatus.Active, new Date()],
    PlanChangeReason.Expired,
    manager
  );

/**
 * Moves the paid window forward, never backward. Renewal webhooks arrive out of order and
 * billingPeriodEnd is only a cache of the subscription's schedule, so healing it forward is
 * always safe while overwriting it with an older date would expire a paying customer.
 */
export const extendOrganizationBillingPeriod = async (
  organizationId: string,
  periodEnd: Date,
  manager?: EntityManager
): Promise<void> => {
  const m = manager ?? AppDataSource.manager;
  await m.query(
    `UPDATE "organizations"
        SET "billing_period_end" =
              GREATEST(COALESCE("billing_period_end", $2::timestamp), $2::timestamp),
            "billing_status" = $3::"public"."users_billingstatus_enum",
            "updatedAt" = now()
      WHERE "id" = $1
        AND "billing_plan" <> $4`,
    [organizationId, periodEnd, BillingStatus.Active, DEFAULT_BILLING_PLAN_KEY]
  );
};
