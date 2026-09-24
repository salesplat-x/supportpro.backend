import { MoreThan } from "typeorm";

import { AppDataSource } from "../database/dataSource.js";
import { FeatureUsageCounter } from "../entities/FeatureUsageCounter.js";
import { Job } from "../entities/Job.js";
import { Organization } from "../entities/Organization.js";
import { OrganizationMember } from "../entities/OrganizationMember.js";
import { Subscription } from "../entities/Subscription.js";
import { getPlanByKey, PricingFeature } from "../config/pricingCatalog.js";
import {
  BillingInterval,
  BillingStatus,
  DEFAULT_BILLING_PLAN_KEY,
  JobStatus,
  SubscriptionStatus,
} from "../types/enums.js";
import { NotFoundError } from "../utils/errors";
import { PlanLimitError } from "../utils/errors";
import { extendOrganizationBillingPeriod, revertToPayPerUseIfExpired } from "./billingState.js";

const counterRepo = () => AppDataSource.getRepository(FeatureUsageCounter);
const organizationRepo = () => AppDataSource.getRepository(Organization);
const jobRepo = () => AppDataSource.getRepository(Job);
const memberRepo = () => AppDataSource.getRepository(OrganizationMember);
const subscriptionRepo = () => AppDataSource.getRepository(Subscription);

const isPayAsYouGo = (billingPlan?: string | null): boolean =>
  !billingPlan || billingPlan === DEFAULT_BILLING_PLAN_KEY;

export const getPlanFeature = (
  organization: Organization,
  featureKey: string
): PricingFeature | undefined => {
  const plan = getPlanByKey(organization.billingPlan);
  return plan?.features.find((feature) => feature.key === featureKey);
};

export const hasFlag = (organization: Organization, featureKey: string): boolean => {
  const feature = getPlanFeature(organization, featureKey);
  return feature?.kind === "flag" && feature.included === true;
};

export const currentPeriodStart = (): string => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
};

const readCounter = async (organizationId: string, featureKey: string): Promise<number> => {
  const counter = await counterRepo().findOne({
    where: { organizationId, featureKey, periodStart: currentPeriodStart() },
  });
  return counter?.count ?? 0;
};

/** Zero monthly meters for the current calendar period after a plan change. */
export const resetPeriodUsage = async (organizationId: string): Promise<void> => {
  await counterRepo()
    .createQueryBuilder()
    .update(FeatureUsageCounter)
    .set({ count: 0 })
    .where(`"organization_id" = :organizationId`, { organizationId })
    .andWhere(`"period_start" = :periodStart`, { periodStart: currentPeriodStart() })
    .execute();
};

/**
 * Finds a subscription that says the organization is still paying, despite an expired
 * billingPeriodEnd. billingPeriodEnd is only a cache of the subscription's schedule, so a
 * renewal webhook that never arrived must not cost a paying customer their plan.
 */
const findLiveSubscriptionPeriodEnd = async (organizationId: string): Promise<Date | null> => {
  const now = new Date();
  const live = await subscriptionRepo().find({
    where: [
      {
        organizationId,
        status: SubscriptionStatus.Active,
        nextPaymentDate: MoreThan(now),
      },
      {
        organizationId,
        status: SubscriptionStatus.Active,
        expiryDate: MoreThan(now),
      },
    ],
  });

  const future = live
    .flatMap((subscription) => [subscription.nextPaymentDate, subscription.expiryDate])
    .filter((date): date is Date => date instanceof Date && date.getTime() > now.getTime())
    .sort((a, b) => b.getTime() - a.getTime());

  return future[0] ?? null;
};

/**
 * Reverts the organization to pay per use once its paid period has ended. Called before
 * entitlement checks and usage reads, so the common (unexpired) case must issue no SQL at
 * all — the three early exits below guarantee that.
 */
export const ensureOrganizationBillingCurrent = async (
  organization: Organization
): Promise<Organization> => {
  if (isPayAsYouGo(organization.billingPlan)) {
    return organization;
  }
  if (!organization.billingPeriodEnd) {
    return organization;
  }
  if (organization.billingPeriodEnd.getTime() > Date.now()) {
    return organization;
  }

  const liveUntil = await findLiveSubscriptionPeriodEnd(organization.id);
  if (liveUntil) {
    await extendOrganizationBillingPeriod(organization.id, liveUntil);
    organization.billingPeriodEnd = liveUntil;
    organization.billingStatus = BillingStatus.Active;
    return organization;
  }

  const reverted = await revertToPayPerUseIfExpired(organization.id);
  if (reverted) {
    organization.billingPlan = DEFAULT_BILLING_PLAN_KEY;
    organization.billingInterval = null;
    organization.billingStatus = BillingStatus.Cancelled;
    organization.billingPeriodEnd = null;
    return organization;
  }

  // Nothing changed, so someone else won the race — an upgrade landed, a renewal extended
  // the period, or a parallel request already reverted. This snapshot is stale either way.
  return (await organizationRepo().findOne({ where: { id: organization.id } })) ?? organization;
};

/**
 * Throws PlanLimitError if the organization is at/over its plan's limit for this feature.
 * No-ops for unlimited plans or features the catalogue doesn't gate.
 */
export const assertWithinLimit = async (
  organization: Organization,
  featureKey: string,
  currentConcurrentCount?: () => Promise<number>
): Promise<void> => {
  const org = await ensureOrganizationBillingCurrent(organization);
  const feature = getPlanFeature(org, featureKey);
  if (!feature || feature.kind !== "metered") return;
  if (feature.limit == null) return; // unlimited

  let used: number;
  if (feature.period === "concurrent") {
    if (!currentConcurrentCount) {
      throw new Error(`assertWithinLimit: ${featureKey} requires currentConcurrentCount`);
    }
    used = await currentConcurrentCount();
  } else {
    used = await readCounter(org.id, featureKey);
  }

  if (used >= feature.limit) {
    throw new PlanLimitError(
      `Your company has reached its plan limit for ${feature.label ?? featureKey} (${feature.limit}). Ask your organization owner to upgrade.`,
      featureKey,
      org.billingPlan
    );
  }
};

/** Increments the current-month usage counter. No-op for 'concurrent' features. */
export const recordUsage = async (
  organization: Organization,
  featureKey: string,
  amount = 1
): Promise<void> => {
  const org = await ensureOrganizationBillingCurrent(organization);
  const feature = getPlanFeature(org, featureKey);
  if (!feature || feature.kind !== "metered" || feature.period !== "monthly") return;

  // One statement: creates the period row and increments it atomically, so concurrent
  // requests can't both read the same count and write the same total. ON CONFLICT infers
  // the target from the column list — UQ_feature_usage_counters_org_feature_period is a
  // UNIQUE INDEX, not a constraint, so naming it would fail at runtime.
  await AppDataSource.query(
    `INSERT INTO "feature_usage_counters"
       ("organization_id", "feature_key", "period_start", "count", "createdAt", "updatedAt")
     VALUES ($1, $2, $3::date, $4, now(), now())
     ON CONFLICT ("organization_id", "feature_key", "period_start")
     DO UPDATE SET "count" = "feature_usage_counters"."count" + EXCLUDED."count",
                   "updatedAt" = now()`,
    [org.id, featureKey, currentPeriodStart(), amount]
  );
};

export type UsageMeter = {
  key: string;
  label: string;
  used: number;
  limit: number | null;
  period: "concurrent" | "monthly";
};

export type OrganizationUsageSnapshot = {
  billingPlan: string;
  billingInterval: BillingInterval | null;
  billingStatus: BillingStatus;
  billingPeriodEnd: Date | null;
  meters: UsageMeter[];
  flags: Array<{ key: string; label: string; included: boolean }>;
};

export const getOrganizationUsage = async (
  organizationId: string
): Promise<OrganizationUsageSnapshot> => {
  let organization = await organizationRepo().findOne({ where: { id: organizationId } });
  if (!organization) {
    throw new NotFoundError("Organization not found");
  }
  organization = await ensureOrganizationBillingCurrent(organization);

  const plan = getPlanByKey(organization.billingPlan);
  const features = plan?.features ?? [];
  const meters: UsageMeter[] = [];
  const flags: Array<{ key: string; label: string; included: boolean }> = [];

  for (const feature of features) {
    if (!feature.key) continue;
    if (feature.kind === "flag") {
      flags.push({
        key: feature.key,
        label: feature.label ?? feature.key,
        included: feature.included === true,
      });
      continue;
    }
    if (feature.kind !== "metered") continue;

    let used = 0;
    if (feature.period === "concurrent") {
      if (feature.key === "job_listings") {
        used = await jobRepo().count({
          where: { organizationId, status: JobStatus.Active },
        });
      } else if (feature.key === "team_members") {
        used = await memberRepo().count({ where: { organizationId } });
      }
    } else {
      used = await readCounter(organizationId, feature.key);
    }

    meters.push({
      key: feature.key,
      label: feature.label ?? feature.key,
      used,
      limit: feature.limit ?? null,
      period: feature.period === "concurrent" ? "concurrent" : "monthly",
    });
  }

  return {
    billingPlan: organization.billingPlan,
    billingInterval: organization.billingInterval,
    billingStatus: organization.billingStatus,
    billingPeriodEnd: organization.billingPeriodEnd,
    meters,
    flags,
  };
};
