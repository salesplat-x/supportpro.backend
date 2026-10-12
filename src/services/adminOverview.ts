import { AppDataSource } from "../database/dataSource.js";
import { User } from "../entities";
import { UserRole } from "../types/enums.js";
import { stuckApplicationSql } from "./applicationFollowUps.js";
import { ONBOARDING_SQL_PARAMS, recruiterStageSql, talentStageSql } from "./onboarding.js";

export const OVERVIEW_RANGES = [7, 30, 90] as const;
export const DEFAULT_OVERVIEW_DAYS = 30;

export interface CountBucket {
  key: string;
  count: number;
}

export interface PeriodTotals {
  total: number;
  new: number;
  previous: number;
}

export interface AdminOverview {
  range: { days: number; from: string; to: string };
  kpis: {
    talents: PeriodTotals;
    recruiters: PeriodTotals;
    organizations: { total: number; pending: number; verified: number; rejected: number };
    jobs: { total: number; active: number };
    applications: PeriodTotals;
    stuckApplications: number;
    unreadFeedback: number;
    unresolvedErrors: number;
    revenue: { total: number; inRange: number; previous: number };
  };
  series: {
    signups: Array<{ date: string; talents: number; recruiters: number }>;
    applications: Array<{ date: string; count: number }>;
    revenue: Array<{ date: string; amount: number }>;
  };
  breakdowns: {
    applicationsByStatus: CountBucket[];
    jobsByStatus: CountBucket[];
    organizationsByPlan: CountBucket[];
    talentOnboarding: CountBucket[];
    recruiterOnboarding: CountBucket[];
    stuckByStage: CountBucket[];
    scoutRunsByStatus: CountBucket[];
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const REVENUE_CURRENCY = "NGN";
const PAYMENT_COMPLETED = "completed";

const dateKey = (date: Date): string => date.toISOString().slice(0, 10);

const startOfUtcDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const run = <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
  AppDataSource.query(sql, params) as Promise<T[]>;

const scalar = async (sql: string, params: unknown[] = []): Promise<number> => {
  const [row] = await run<{ value: number | string | null }>(sql, params);
  return Number(row?.value ?? 0);
};

const buckets = async (sql: string, params: unknown[] = []): Promise<CountBucket[]> => {
  const rows = await run<{ key: string | null; count: number | string }>(sql, params);
  return rows.map((row) => ({ key: row.key ?? "unknown", count: Number(row.count) }));
};

const onboardingBuckets = async (
  role: UserRole.Talent | UserRole.Recruiter,
  stageSql: (alias: string) => string
): Promise<CountBucket[]> => {
  const rows: Array<{ stage: string; count: string }> = await AppDataSource.getRepository(User)
    .createQueryBuilder("user")
    .select(stageSql('"user"'), "stage")
    .addSelect("COUNT(*)", "count")
    .where('"user"."userRole" = :role', { role })
    .setParameters(ONBOARDING_SQL_PARAMS)
    .groupBy("stage")
    .getRawMany();
  return rows.map((row) => ({ key: row.stage, count: Number(row.count) }));
};

export const getAdminOverview = async (days: number = DEFAULT_OVERVIEW_DAYS): Promise<AdminOverview> => {
  const today = startOfUtcDay(new Date());
  const from = new Date(today.getTime() - (days - 1) * DAY_MS);
  const previousFrom = new Date(from.getTime() - days * DAY_MS);
  const rangeEnd = new Date(today.getTime() + DAY_MS);

  const fromKey = dateKey(from);
  const todayKey = dateKey(today);
  const previousFromKey = dateKey(previousFrom);
  const rangeEndKey = dateKey(rangeEnd);

  const userCounts = (role: UserRole) =>
    run<{ total: number; new: number; previous: number }>(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE "createdAt" >= $2::timestamp AND "createdAt" < $3::timestamp)::int AS new,
         COUNT(*) FILTER (WHERE "createdAt" >= $4::timestamp AND "createdAt" < $2::timestamp)::int AS previous
       FROM users WHERE "userRole" = $1`,
      [role, fromKey, rangeEndKey, previousFromKey]
    ).then(([row]) => ({ total: row?.total ?? 0, new: row?.new ?? 0, previous: row?.previous ?? 0 }));

  const [
    talents,
    recruiters,
    organizationStatuses,
    jobsByStatus,
    applicationTotals,
    applicationsByStatus,
    stuckApplications,
    stuckByStage,
    unreadFeedback,
    unresolvedErrors,
    revenue,
    organizationsByPlan,
    scoutRunsByStatus,
    talentOnboarding,
    recruiterOnboarding,
    signups,
    applicationSeries,
    revenueSeries,
  ] = await Promise.all([
    userCounts(UserRole.Talent),
    userCounts(UserRole.Recruiter),
    buckets(`SELECT status::text AS key, COUNT(*)::int AS count FROM organizations GROUP BY status`),
    buckets(`SELECT status::text AS key, COUNT(*)::int AS count FROM jobs GROUP BY status ORDER BY count DESC`),
    run<{ total: number; new: number; previous: number }>(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE "createdAt" >= $1::timestamp AND "createdAt" < $2::timestamp)::int AS new,
         COUNT(*) FILTER (WHERE "createdAt" >= $3::timestamp AND "createdAt" < $1::timestamp)::int AS previous
       FROM applications`,
      [fromKey, rangeEndKey, previousFromKey]
    ),
    buckets(`SELECT status::text AS key, COUNT(*)::int AS count FROM applications GROUP BY status ORDER BY count DESC`),
    scalar(`SELECT COUNT(*)::int AS value FROM applications a WHERE ${stuckApplicationSql("a")}`),
    buckets(
      `SELECT a."currentStage"::text AS key, COUNT(*)::int AS count
       FROM applications a WHERE ${stuckApplicationSql("a")}
       GROUP BY a."currentStage" ORDER BY count DESC`
    ),
    scalar(`SELECT COUNT(*)::int AS value FROM feedback WHERE "isRead" = false`),
    scalar(`SELECT COUNT(*)::int AS value FROM error_logs WHERE resolved = false`),
    run<{ total: number | null; in_range: number | null; previous: number | null }>(
      `SELECT
         SUM(amount)::float8 AS total,
         SUM(amount) FILTER (WHERE COALESCE("paidAt", "createdAt") >= $3::timestamp
                               AND COALESCE("paidAt", "createdAt") < $4::timestamp)::float8 AS in_range,
         SUM(amount) FILTER (WHERE COALESCE("paidAt", "createdAt") >= $5::timestamp
                               AND COALESCE("paidAt", "createdAt") < $3::timestamp)::float8 AS previous
       FROM payments WHERE status = $1 AND currency = $2`,
      [PAYMENT_COMPLETED, REVENUE_CURRENCY, fromKey, rangeEndKey, previousFromKey]
    ),
    buckets(
      `SELECT billing_plan AS key, COUNT(*)::int AS count FROM organizations GROUP BY billing_plan ORDER BY count DESC`
    ),
    buckets(`SELECT status::text AS key, COUNT(*)::int AS count FROM scout_runs GROUP BY status ORDER BY count DESC`),
    onboardingBuckets(UserRole.Talent, talentStageSql),
    onboardingBuckets(UserRole.Recruiter, recruiterStageSql),
    run<{ date: string; talents: number; recruiters: number }>(
      `SELECT to_char(d, 'YYYY-MM-DD') AS date,
         COUNT(u.id) FILTER (WHERE u."userRole" = 'talent')::int AS talents,
         COUNT(u.id) FILTER (WHERE u."userRole" = 'recruiter')::int AS recruiters
       FROM generate_series($1::timestamp, $2::timestamp, interval '1 day') d
       LEFT JOIN users u ON u."createdAt" >= d AND u."createdAt" < d + interval '1 day'
         AND u."userRole" IN ('talent', 'recruiter')
       GROUP BY d ORDER BY d`,
      [fromKey, todayKey]
    ),
    run<{ date: string; count: number }>(
      `SELECT to_char(d, 'YYYY-MM-DD') AS date, COUNT(a.id)::int AS count
       FROM generate_series($1::timestamp, $2::timestamp, interval '1 day') d
       LEFT JOIN applications a ON a."createdAt" >= d AND a."createdAt" < d + interval '1 day'
       GROUP BY d ORDER BY d`,
      [fromKey, todayKey]
    ),
    run<{ date: string; amount: number }>(
      `SELECT to_char(d, 'YYYY-MM-DD') AS date, COALESCE(SUM(p.amount), 0)::float8 AS amount
       FROM generate_series($1::timestamp, $2::timestamp, interval '1 day') d
       LEFT JOIN payments p ON p.status = $3 AND p.currency = $4
         AND COALESCE(p."paidAt", p."createdAt") >= d
         AND COALESCE(p."paidAt", p."createdAt") < d + interval '1 day'
       GROUP BY d ORDER BY d`,
      [fromKey, todayKey, PAYMENT_COMPLETED, REVENUE_CURRENCY]
    ),
  ]);

  const orgStatus = (status: string) =>
    organizationStatuses.find((bucket) => bucket.key === status)?.count ?? 0;
  const jobStatus = (status: string) =>
    jobsByStatus.find((bucket) => bucket.key === status)?.count ?? 0;
  const applications = applicationTotals[0];
  const revenueTotals = revenue[0];

  return {
    range: { days, from: fromKey, to: todayKey },
    kpis: {
      talents,
      recruiters,
      organizations: {
        total: organizationStatuses.reduce((sum, bucket) => sum + bucket.count, 0),
        pending: orgStatus("pending"),
        verified: orgStatus("verified"),
        rejected: orgStatus("rejected"),
      },
      jobs: {
        total: jobsByStatus.reduce((sum, bucket) => sum + bucket.count, 0),
        active: jobStatus("active"),
      },
      applications: {
        total: applications?.total ?? 0,
        new: applications?.new ?? 0,
        previous: applications?.previous ?? 0,
      },
      stuckApplications,
      unreadFeedback,
      unresolvedErrors,
      revenue: {
        total: revenueTotals?.total ?? 0,
        inRange: revenueTotals?.in_range ?? 0,
        previous: revenueTotals?.previous ?? 0,
      },
    },
    series: { signups, applications: applicationSeries, revenue: revenueSeries },
    breakdowns: {
      applicationsByStatus,
      jobsByStatus,
      organizationsByPlan,
      talentOnboarding,
      recruiterOnboarding,
      stuckByStage,
      scoutRunsByStatus,
    },
  };
};
