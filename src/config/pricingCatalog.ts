import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { BillingInterval } from "../types/enums.js";

export interface PricingFeature {
  text: string;
  included: boolean;
}

export interface PricingPlan {
  key: "free" | "paid";
  name: string;
  description: string;
  priceCaption?: string;
  badge?: string;
  cta: string;
  highlighted: boolean;
  monthlyAmountNgn: number;
  yearlyAmountNgn: number;
  features: PricingFeature[];
}

export interface ComparisonRow {
  id: string;
  label: string;
  hint: string | null;
  free: string | boolean;
  paid: string | boolean;
}

export interface PricingCatalog {
  currency: string;
  currencySymbol: string;
  yearlyDiscountPercent: number;
  guarantee: string;
  cancelAnytime: string;
  hero: { kicker: string; title: string; subtitle: string };
  plans: PricingPlan[];
  comparison: { columns: string[]; rows: ComparisonRow[] };
  valueProps: {
    badge: string;
    title: string;
    body: string;
    items: Array<{ title: string; body: string; icon: string }>;
  };
  contact: { prompt: string; cta: string; href: string };
  dummyUsage: Array<{ id: string; label: string; used: number; limit: string }>;
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

export const getPaidPlan = (): PricingPlan => {
  const plan = loadPricingCatalog().plans.find((item) => item.key === "paid");
  if (!plan) throw new Error("Paid plan missing from pricing.yaml");
  return plan;
};

export const amountKoboForInterval = (interval: BillingInterval): number => {
  const plan = getPaidPlan();
  const ngn = interval === BillingInterval.Annually ? plan.yearlyAmountNgn : plan.monthlyAmountNgn;
  return Math.round(ngn * NGN_TO_KOBO);
};

export const ngnToKobo = (ngn: number): number => Math.round(ngn * NGN_TO_KOBO);
