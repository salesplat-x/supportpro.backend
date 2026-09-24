import { EntityManager } from "typeorm";

import { AppDataSource } from "../database/dataSource.js";
import { Organization } from "../entities/Organization.js";
import {
  BillingInterval,
  BillingStatus,
  DEFAULT_BILLING_PLAN_KEY,
  SubscriptionStatus,
} from "../types/enums.js";

/**
 * The single writer for organizations.billing_*. Billing lives on the organization and is
 * shared by every member, so a half-applied plan change is a billing bug — every write here
 * sets all four columns together.
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

/** What an organization reverts to when a paid period ends or a subscription dies. */
export const PAY_PER_USE_STATE: BillingState = {
  billingPlan: DEFAULT_BILLING_PLAN_KEY,
  billingInterval: null,
  billingStatus: BillingStatus.Cancelled,
  billingPeriodEnd: null,
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
 * otherwise. Returns null when the organization no longer exists.
 */
export const setOrganizationBilling = async (
  organizationId: string,
  state: BillingState,
  manager?: EntityManager
): Promise<Organization | null> => {
  const run = async (m: EntityManager): Promise<Organization | null> => {
    const organization = await m.findOne(Organization, {
      where: { id: organizationId },
      lock: { mode: "pessimistic_write" },
    });
    if (!organization) return null;

    organization.billingPlan = state.billingPlan;
    organization.billingInterval = state.billingInterval;
    organization.billingStatus = state.billingStatus;
    organization.billingPeriodEnd = state.billingPeriodEnd;
    return m.save(organization);
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
 * Reverts to pay per use only while the organization is still on the plan the caller saw.
 * One statement, so an upgrade that lands mid-flight makes this a no-op instead of wiping
 * the plan the customer just paid for.
 */
export const revertToPayPerUseIfStillOnPlan = async (
  organizationId: string,
  expectedPlanKey: string,
  manager?: EntityManager
): Promise<boolean> => {
  const m = manager ?? AppDataSource.manager;
  const result = await m
    .createQueryBuilder()
    .update(Organization)
    .set(PAY_PER_USE_STATE)
    .where(`"id" = :organizationId`, { organizationId })
    .andWhere(`"billing_plan" = :expectedPlanKey`, { expectedPlanKey })
    .execute();
  return (result.affected ?? 0) > 0;
};

/**
 * Reverts to pay per use only if the paid period is still past at the moment of the write
 * and no live subscription contradicts it. The expiry re-check and the subscription guard
 * are both in SQL so a concurrent renewal or upgrade cannot lose the race.
 */
export const revertToPayPerUseIfExpired = async (
  organizationId: string,
  manager?: EntityManager
): Promise<boolean> => {
  const m = manager ?? AppDataSource.manager;
  const result = await m
    .createQueryBuilder()
    .update(Organization)
    .set(PAY_PER_USE_STATE)
    .where(`"id" = :organizationId`, { organizationId })
    .andWhere(`"billing_plan" NOT IN (:...payAsYouGo)`, {
      payAsYouGo: PAY_AS_YOU_GO_KEYS,
    })
    .andWhere(`"billing_period_end" IS NOT NULL`)
    .andWhere(`"billing_period_end" <= now()`)
    .andWhere(
      `NOT EXISTS (
         SELECT 1 FROM "subscriptions" s
          WHERE s."organization_id" = :guardOrganizationId
            AND s."status" = :activeSubscription
            AND COALESCE(s."nextPaymentDate", s."expiryDate") > now()
       )`,
      {
        guardOrganizationId: organizationId,
        activeSubscription: SubscriptionStatus.Active,
      }
    )
    .execute();
  return (result.affected ?? 0) > 0;
};

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
