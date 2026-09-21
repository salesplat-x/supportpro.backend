import { AppDataSource } from "../database/dataSource.js";
import { FeatureUsageCounter } from "../entities/FeatureUsageCounter.js";
import { Organization } from "../entities/Organization.js";
import { getPlanByKey, PricingFeature } from "../config/pricingCatalog.js";
import { PlanLimitError } from "../utils/errors";

const counterRepo = () => AppDataSource.getRepository(FeatureUsageCounter);

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

const currentPeriodStart = (): string => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
};

const getOrCreateCounter = async (
  organizationId: string,
  featureKey: string
): Promise<FeatureUsageCounter> => {
  const periodStart = currentPeriodStart();
  const existing = await counterRepo().findOne({
    where: { organizationId, featureKey, periodStart },
  });
  if (existing) return existing;
  return counterRepo().save(
    counterRepo().create({ organizationId, featureKey, periodStart, count: 0 })
  );
};

/**
 * Throws PlanLimitError if the organization is at/over its plan's limit for this feature.
 * No-ops for unlimited plans or features the catalogue doesn't gate.
 *
 * `currentConcurrentCount` is required for `period: 'concurrent'` features (job_listings,
 * team_members) — the caller supplies a live count (e.g. active jobs right now) since
 * that's always more accurate than a separately-tracked counter.
 */
export const assertWithinLimit = async (
  organization: Organization,
  featureKey: string,
  currentConcurrentCount?: () => Promise<number>
): Promise<void> => {
  const feature = getPlanFeature(organization, featureKey);
  if (!feature || feature.kind !== "metered") return;
  if (feature.limit == null) return; // unlimited

  let used: number;
  if (feature.period === "concurrent") {
    if (!currentConcurrentCount) {
      throw new Error(`assertWithinLimit: ${featureKey} requires currentConcurrentCount`);
    }
    used = await currentConcurrentCount();
  } else {
    const counter = await getOrCreateCounter(organization.id, featureKey);
    used = counter.count;
  }

  if (used >= feature.limit) {
    throw new PlanLimitError(
      `Your company has reached its plan limit for ${feature.label ?? featureKey} (${feature.limit}). Ask your organization owner to upgrade.`,
      featureKey,
      organization.billingPlan
    );
  }
};

/** Increments the current-month usage counter. No-op for 'concurrent' features (derived live, not counted). */
export const recordUsage = async (
  organization: Organization,
  featureKey: string,
  amount = 1
): Promise<void> => {
  const feature = getPlanFeature(organization, featureKey);
  if (!feature || feature.kind !== "metered" || feature.period !== "monthly") return;

  const counter = await getOrCreateCounter(organization.id, featureKey);
  await counterRepo().save({ ...counter, count: counter.count + amount });
};
