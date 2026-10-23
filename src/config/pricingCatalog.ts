import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { BillingInterval, DEFAULT_BILLING_PLAN_KEY } from "../types/enums.js";

export interface PricingFeature {
  key?: string;
  label?: string;
  text?: string;
  kind?: "metered" | "flag";
  limit?: number | null;
  period?: "concurrent" | "monthly";
  included?: boolean;
}

export interface PricingPlan {
  key: string;
  name: string;
  description: string;
  priceCaption?: string;
  badge?: string;
  badgeTone?: "success";
  cta: string;
  secondaryCta?: string;
  highlighted: boolean;
  visible?: boolean;
  purchasable?: boolean;
  monthlyAmountNgn: number;
  yearlyAmountNgn: number | null;
  /** Display-only USD; billing remains NGN via Paystack. */
  monthlyAmountUsd: number;
  yearlyAmountUsd: number | null;
  featuresIntro: string | null;
  /** Plan whose keyed features this plan also grants ("Everything in X, plus"). */
  inherits?: string;
  features: PricingFeature[];
}

export interface PricingCatalog {
  currency: string;
  currencySymbol: string;
  yearlyDiscountPercent: number;
  guarantee: string;
  cancelAnytime: string;
  hero: { kicker: string; title: string; subtitle: string };
  plans: PricingPlan[];
  valueProps: {
    badge: string;
    title: string;
    body: string;
    items: Array<{ title: string; body: string; icon: string }>;
  };
  contact: { prompt: string; cta: string; href: string };
}

const NGN_TO_KOBO = 100;

const resolveYamlPath = (): string => {
  const candidates = [
    path.join(__dirname, "pricing.yaml"),
    path.join(process.cwd(), "src/config/pricing.yaml"),
    path.join(process.cwd(), "dist/config/pricing.yaml"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("pricing.yaml not found");
  }
  return found;
};

let cached: PricingCatalog | null = null;

export const loadPricingCatalog = (): PricingCatalog => {
  if (cached) return cached;
  const raw = yaml.load(fs.readFileSync(resolveYamlPath(), "utf8")) as PricingCatalog;
  cached = raw;
  return raw;
};

/** Public-facing catalogue: strips hidden/legacy plans (e.g. the grandfathered `paid` tier). */
export const publicCatalog = (): PricingCatalog => {
  const catalog = loadPricingCatalog();
  return { ...catalog, plans: catalog.plans.filter((plan) => plan.visible !== false) };
};

export const getPlanByKey = (key: string): PricingPlan | undefined =>
  loadPricingCatalog().plans.find((plan) => plan.key === key);

/**
 * Keyed features a plan grants, including those inherited from the plans it builds on. The
 * plan's own entry wins over an inherited one with the same key, so a tier can raise a limit.
 */
export const getEffectivePlanFeatures = (key: string): PricingFeature[] => {
  const features: PricingFeature[] = [];
  const seenKeys = new Set<string>();
  const visitedPlans = new Set<string>();
  let plan = getPlanByKey(key);
  while (plan && !visitedPlans.has(plan.key)) {
    visitedPlans.add(plan.key);
    for (const feature of plan.features) {
      if (!feature.key || seenKeys.has(feature.key)) continue;
      seenKeys.add(feature.key);
      features.push(feature);
    }
    plan = plan.inherits ? getPlanByKey(plan.inherits) : undefined;
  }
  return features;
};

/** Plans a customer can actually check out (excludes hidden/legacy, includes pay_per_use). */
export const getPurchasablePlans = (): PricingPlan[] =>
  loadPricingCatalog().plans.filter((plan) => plan.visible !== false && plan.purchasable !== false);

/** Subscription-billed plans only (excludes pay_per_use, which has no recurring Paystack plan). */
export const getSubscriptionPlans = (): PricingPlan[] =>
  getPurchasablePlans().filter((plan) => plan.key !== DEFAULT_BILLING_PLAN_KEY);

export const getSubscriptionPlanKeys = (): string[] =>
  getSubscriptionPlans().map((plan) => plan.key);

/** Monthly-equivalent NGN amount for a plan+interval — matches Plan.amount's existing contract. */
export const monthlyEquivalentNgn = (plan: PricingPlan, interval: BillingInterval): number => {
  if (interval === BillingInterval.Annually) {
    if (plan.yearlyAmountNgn == null) {
      throw new Error(`Plan ${plan.key} has no annual pricing`);
    }
    return Math.round(plan.yearlyAmountNgn / 12);
  }
  return plan.monthlyAmountNgn;
};

export const ngnToKobo = (ngn: number): number => Math.round(ngn * NGN_TO_KOBO);
