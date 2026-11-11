import { AppDataSource } from "../database/dataSource.js";
import { Job } from "../entities/Job.js";
import { CompensationPeriod, JobStatus } from "../types/enums.js";

/**
 * Day 10 (plan feature 5): what similar AuxHR jobs pay. Similar = same role,
 * experience level and location (city, state and country, case-insensitive;
 * a location field left empty is not compared). Drafts are left out. Each job's
 * pay is the middle of its range, or its minimum when it has no maximum.
 * Results are converted to the asked currency and period and hidden when fewer
 * than MIN_JOBS jobs can be compared.
 */
export const MIN_JOBS = 5;

export interface SalaryComparisonQuery {
  roleId: string;
  experienceLevel: string;
  currency: string;
  compensationPeriod: CompensationPeriod;
  locationCity?: string;
  locationState?: string;
  locationCountry?: string;
  excludeJobId?: string;
}

export type SalaryComparison =
  | { available: false }
  | {
      available: true;
      count: number;
      low: number;
      middle: number;
      high: number;
      currency: string;
      compensationPeriod: CompensationPeriod;
    };

/**
 * Exchange rates come from config: SALARY_FX_RATES is a JSON map of currency to
 * units per one common base currency, e.g. {"USD":1,"NGN":1500,"GBP":0.79,"EUR":0.92}.
 * Without it, only jobs already in the asked currency are compared.
 */
const fxRates = (): Record<string, number> => {
  try {
    const parsed = JSON.parse(process.env["SALARY_FX_RATES"] ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, v]) => typeof v === "number" && v > 0)
        .map(([k, v]) => [k.toUpperCase(), v as number])
    );
  } catch {
    return {};
  }
};

const convertCurrency = (
  amount: number,
  from: string,
  to: string,
  rates: Record<string, number>
): number | null => {
  if (from === to) return amount;
  const fromRate = rates[from];
  const toRate = rates[to];
  if (!fromRate || !toRate) return null;
  return (amount / fromRate) * toRate;
};

const convertPeriod = (amount: number, from: CompensationPeriod, to: CompensationPeriod) => {
  if (from === to) return amount;
  return to === CompensationPeriod.Monthly ? amount / 12 : amount * 12;
};

const median = (sorted: number[]): number => {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export const compareSalaries = async (query: SalaryComparisonQuery): Promise<SalaryComparison> => {
  const currency = query.currency.toUpperCase();
  const qb = AppDataSource.getRepository(Job)
    .createQueryBuilder("job")
    .where("job.role_id = :roleId", { roleId: query.roleId })
    .andWhere('job."experienceLevel" = :level', { level: query.experienceLevel })
    .andWhere("job.status != :draft", { draft: JobStatus.Draft });

  for (const field of ["locationCity", "locationState", "locationCountry"] as const) {
    const value = query[field]?.trim();
    if (value) {
      qb.andWhere(`LOWER(job."${field}") = :${field}`, { [field]: value.toLowerCase() });
    }
  }
  if (query.excludeJobId) {
    qb.andWhere("job.id != :excludeJobId", { excludeJobId: query.excludeJobId });
  }

  const jobs = await qb.getMany();
  const rates = fxRates();
  const pays = jobs
    .map((job) => {
      const pay = job.maxSalary != null ? (job.minSalary + job.maxSalary) / 2 : job.minSalary;
      const inCurrency = convertCurrency(pay, (job.currency ?? "").toUpperCase(), currency, rates);
      if (inCurrency == null) return null;
      return convertPeriod(inCurrency, job.compensationPeriod, query.compensationPeriod);
    })
    .filter((pay): pay is number => pay != null && Number.isFinite(pay))
    .sort((a, b) => a - b);

  if (pays.length < MIN_JOBS) return { available: false };

  return {
    available: true,
    count: pays.length,
    low: Math.round(pays[0]!),
    middle: Math.round(median(pays)),
    high: Math.round(pays[pays.length - 1]!),
    currency,
    compensationPeriod: query.compensationPeriod,
  };
};
