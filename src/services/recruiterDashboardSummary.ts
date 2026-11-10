import { AppDataSource } from "../database/dataSource.js";
import {
  ApplicationStatus,
  ApplicationType,
  JobStatus,
  MatchVerdictStatus,
  ScreeningStage,
} from "../types/enums.js";
import { getActiveOrganizationId } from "./organizationScope.js";

export const SUMMARY_RANGES = [7, 30, 90] as const;
export const DEFAULT_SUMMARY_DAYS = 7;
export const SUMMARY_CHARTS = ["7d", "12w", "1y"] as const;
export type SummaryChart = (typeof SUMMARY_CHARTS)[number];
export const DEFAULT_SUMMARY_CHART: SummaryChart = "12w";

export const APPLICANTS_MAX_LIMIT = 50;
export const APPLICANTS_DEFAULT_LIMIT = 7;
export const ACTIVE_JOB_POSTS_LIMIT = 5;

export interface RecruiterDashboardSummary {
  range: { days: number; from: string; to: string };
  kpis: {
    activeJobs: { total: number; new: number };
    applications: { total: number; current: number; previous: number };
    screened: { total: number; applications: number };
  };
  series: Array<{ date: string; applications: number; screened: number }>;
  status: {
    total: number;
    underReview: number;
    inTesting: number;
    shortlisted: number;
    rejected: number;
  };
  funnel: {
    applied: number;
    cvMatched: number;
    preScreened: number;
    personalityTest: number;
    shortlisted: number;
  };
  activeJobPosts: Array<{
    id: string;
    title: string;
    city: string | null;
    state: string | null;
    country: string | null;
    workMode: string[];
    applicants: number;
    screened: number;
  }>;
}

export interface DashboardApplicant {
  id: string;
  jobId: string;
  applicantName: string;
  role: string | null;
  cvMatch: number | null;
  prescreeningScore: number | null;
  status: ApplicationStatus;
  currentStage: ScreeningStage;
  dateApplied: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const dateKey = (date: Date): string => date.toISOString().slice(0, 10);

const startOfUtcDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const run = <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
  AppDataSource.query(sql, params) as Promise<T[]>;

const SCREENED_SQL = `(a."cvSimilarityScore" IS NOT NULL OR a."matchVerdictStatus" = '${MatchVerdictStatus.Succeeded}')`;

const chartWindow = (
  chart: SummaryChart,
  today: Date
): { first: string; last: string; step: string } => {
  if (chart === "7d") {
    return {
      first: dateKey(new Date(today.getTime() - 6 * DAY_MS)),
      last: dateKey(today),
      step: "1 day",
    };
  }
  if (chart === "12w") {
    const mondayOffset = (today.getUTCDay() + 6) % 7;
    const thisMonday = new Date(today.getTime() - mondayOffset * DAY_MS);
    return {
      first: dateKey(new Date(thisMonday.getTime() - 11 * 7 * DAY_MS)),
      last: dateKey(thisMonday),
      step: "7 days",
    };
  }
  const thisMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  return {
    first: dateKey(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 11, 1))),
    last: dateKey(thisMonth),
    step: "1 month",
  };
};

const emptySummary = (
  range: RecruiterDashboardSummary["range"],
  series: RecruiterDashboardSummary["series"]
): RecruiterDashboardSummary => ({
  range,
  kpis: {
    activeJobs: { total: 0, new: 0 },
    applications: { total: 0, current: 0, previous: 0 },
    screened: { total: 0, applications: 0 },
  },
  series,
  status: { total: 0, underReview: 0, inTesting: 0, shortlisted: 0, rejected: 0 },
  funnel: { applied: 0, cvMatched: 0, preScreened: 0, personalityTest: 0, shortlisted: 0 },
  activeJobPosts: [],
});

const zeroSeries = async (
  window: ReturnType<typeof chartWindow>
): Promise<RecruiterDashboardSummary["series"]> => {
  const rows = await run<{ date: string }>(
    `SELECT to_char(d, 'YYYY-MM-DD') AS date
     FROM generate_series($1::timestamp, $2::timestamp, $3::interval) d ORDER BY d`,
    [window.first, window.last, window.step]
  );
  return rows.map((row) => ({ date: row.date, applications: 0, screened: 0 }));
};

export const getRecruiterDashboardSummary = async (
  recruiterId: string,
  days: number = DEFAULT_SUMMARY_DAYS,
  chart: SummaryChart = DEFAULT_SUMMARY_CHART
): Promise<RecruiterDashboardSummary> => {
  const today = startOfUtcDay(new Date());
  const from = new Date(today.getTime() - (days - 1) * DAY_MS);
  const rangeEnd = new Date(today.getTime() + DAY_MS);
  const previousFrom = new Date(from.getTime() - days * DAY_MS);
  const range = { days, from: dateKey(from), to: dateKey(today) };
  const window = chartWindow(chart, today);

  const organizationId = await getActiveOrganizationId(recruiterId);
  if (!organizationId) return emptySummary(range, await zeroSeries(window));

  const fromKey = dateKey(from);
  const rangeEndKey = dateKey(rangeEnd);
  const previousFromKey = dateKey(previousFrom);
  const inPeriod = `a."createdAt" >= $3::timestamp AND a."createdAt" < $4::timestamp`;
  const onActiveJob = `j.status = '${JobStatus.Active}'`;
  const testing = `a.status IN ('${ApplicationStatus.Pending}', '${ApplicationStatus.RetakeAssessment}')`;
  const completed = `a."currentStage" = '${ScreeningStage.Completed}'`;

  const [totalsRows, activeJobRows, seriesRows, jobPostRows] = await Promise.all([
    run<Record<string, number>>(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE ${inPeriod})::int AS current,
         COUNT(*) FILTER (WHERE a."createdAt" >= $5::timestamp AND a."createdAt" < $3::timestamp)::int AS previous,
         COUNT(*) FILTER (WHERE ${SCREENED_SQL})::int AS screened,
         COUNT(*) FILTER (WHERE ${onActiveJob})::int AS status_total,
         COUNT(*) FILTER (WHERE ${onActiveJob} AND a.status = '${ApplicationStatus.Shortlisted}')::int AS status_shortlisted,
         COUNT(*) FILTER (WHERE ${onActiveJob} AND a.status IN ('${ApplicationStatus.Rejected}', '${ApplicationStatus.NotProceeding}'))::int AS status_rejected,
         COUNT(*) FILTER (WHERE ${onActiveJob} AND ${testing} AND NOT ${completed})::int AS status_in_testing,
         COUNT(*) FILTER (WHERE ${onActiveJob} AND (a.status = '${ApplicationStatus.AwaitingDecision}' OR (${testing} AND ${completed})))::int AS status_under_review,
         COUNT(*) FILTER (WHERE ${inPeriod} AND a."cvSimilarityScore" IS NOT NULL)::int AS funnel_cv_matched,
         COUNT(*) FILTER (WHERE ${inPeriod} AND u."prescreeningScore" IS NOT NULL)::int AS funnel_pre_screened,
         COUNT(*) FILTER (WHERE ${inPeriod} AND a."mbtiType" IS NOT NULL)::int AS funnel_personality,
         COUNT(*) FILTER (WHERE ${inPeriod} AND a.status = '${ApplicationStatus.Shortlisted}')::int AS funnel_shortlisted
       FROM applications a
       JOIN jobs j ON j.id = a.job_id
       LEFT JOIN users u ON u.id = a.talent_id
       WHERE j.organization_id = $1 AND a."applicationType" = $2`,
      [organizationId, ApplicationType.Application, fromKey, rangeEndKey, previousFromKey]
    ),
    run<{ total: number; new: number }>(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE "createdAt" >= $2::timestamp AND "createdAt" < $3::timestamp)::int AS new
       FROM jobs WHERE organization_id = $1 AND status = $4`,
      [organizationId, fromKey, rangeEndKey, JobStatus.Active]
    ),
    run<{ date: string; applications: number; screened: number }>(
      `SELECT to_char(d, 'YYYY-MM-DD') AS date,
         COUNT(a.id)::int AS applications,
         COUNT(a.id) FILTER (WHERE ${SCREENED_SQL})::int AS screened
       FROM generate_series($1::timestamp, $2::timestamp, $3::interval) d
       LEFT JOIN (
         SELECT a.id, a."createdAt", a."cvSimilarityScore", a."matchVerdictStatus"
         FROM applications a JOIN jobs j ON j.id = a.job_id
         WHERE j.organization_id = $4 AND a."applicationType" = $5
       ) a ON a."createdAt" >= d AND a."createdAt" < d + $3::interval
       GROUP BY d ORDER BY d`,
      [window.first, window.last, window.step, organizationId, ApplicationType.Application]
    ),
    run<{
      id: string;
      title: string;
      city: string | null;
      state: string | null;
      country: string | null;
      work_mode: string | null;
      applicants: number;
      screened: number;
    }>(
      `SELECT j.id, r.name AS title,
         j."locationCity" AS city, j."locationState" AS state, j."locationCountry" AS country,
         j."workMode" AS work_mode,
         COUNT(a.id)::int AS applicants,
         COUNT(a.id) FILTER (WHERE ${SCREENED_SQL})::int AS screened
       FROM jobs j
       JOIN roles r ON r.id = j.role_id
       LEFT JOIN applications a ON a.job_id = j.id AND a."applicationType" = $2
       WHERE j.organization_id = $1 AND j.status = $3
       GROUP BY j.id, r.name
       ORDER BY j."createdAt" DESC, j.id DESC
       LIMIT $4`,
      [organizationId, ApplicationType.Application, JobStatus.Active, ACTIVE_JOB_POSTS_LIMIT]
    ),
  ]);

  const totals = totalsRows[0] ?? {};
  const count = (key: string) => Number(totals[key] ?? 0);
  const activeJobs = activeJobRows[0];

  return {
    range,
    kpis: {
      activeJobs: { total: activeJobs?.total ?? 0, new: activeJobs?.new ?? 0 },
      applications: {
        total: count("total"),
        current: count("current"),
        previous: count("previous"),
      },
      screened: { total: count("screened"), applications: count("total") },
    },
    series: seriesRows.map((row) => ({
      date: row.date,
      applications: Number(row.applications),
      screened: Number(row.screened),
    })),
    status: {
      total: count("status_total"),
      underReview: count("status_under_review"),
      inTesting: count("status_in_testing"),
      shortlisted: count("status_shortlisted"),
      rejected: count("status_rejected"),
    },
    funnel: {
      applied: count("current"),
      cvMatched: count("funnel_cv_matched"),
      preScreened: count("funnel_pre_screened"),
      personalityTest: count("funnel_personality"),
      shortlisted: count("funnel_shortlisted"),
    },
    activeJobPosts: jobPostRows.map((row) => ({
      id: row.id,
      title: row.title,
      city: row.city,
      state: row.state,
      country: row.country,
      workMode: row.work_mode ? row.work_mode.split(",").filter(Boolean) : [],
      applicants: Number(row.applicants),
      screened: Number(row.screened),
    })),
  };
};

export const getRecruiterDashboardApplicants = async (
  recruiterId: string,
  limit: number = APPLICANTS_DEFAULT_LIMIT,
  offset = 0
): Promise<{ items: DashboardApplicant[]; total: number }> => {
  const organizationId = await getActiveOrganizationId(recruiterId);
  if (!organizationId) return { items: [], total: 0 };

  const [rows, totalRows] = await Promise.all([
    run<{
      id: string;
      job_id: string;
      first_name: string | null;
      last_name: string | null;
      role: string | null;
      cv_match: number | null;
      prescreening_score: number | null;
      status: ApplicationStatus;
      current_stage: ScreeningStage;
      created_at: Date;
    }>(
      `SELECT a.id, a.job_id, u."firstName" AS first_name, u."lastName" AS last_name,
         r.name AS role, a."cvSimilarityScore" AS cv_match,
         u."prescreeningScore" AS prescreening_score,
         a.status, a."currentStage" AS current_stage, a."createdAt" AS created_at
       FROM applications a
       JOIN jobs j ON j.id = a.job_id
       LEFT JOIN roles r ON r.id = j.role_id
       LEFT JOIN users u ON u.id = a.talent_id
       WHERE j.organization_id = $1 AND a."applicationType" = $2
       ORDER BY a."createdAt" DESC, a.id DESC
       LIMIT $3 OFFSET $4`,
      [organizationId, ApplicationType.Application, limit, offset]
    ),
    run<{ total: number }>(
      `SELECT COUNT(*)::int AS total
       FROM applications a JOIN jobs j ON j.id = a.job_id
       WHERE j.organization_id = $1 AND a."applicationType" = $2`,
      [organizationId, ApplicationType.Application]
    ),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      applicantName: `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || "Applicant",
      role: row.role,
      cvMatch: row.cv_match === null ? null : Number(row.cv_match),
      prescreeningScore: row.prescreening_score === null ? null : Number(row.prescreening_score),
      status: row.status,
      currentStage: row.current_stage,
      dateApplied: row.created_at,
    })),
    total: totalRows[0]?.total ?? 0,
  };
};

export const getRecruiterDashboardCounts = async (
  recruiterId: string
): Promise<{ applications: number; shortlisted: number }> => {
  const organizationId = await getActiveOrganizationId(recruiterId);
  if (!organizationId) return { applications: 0, shortlisted: 0 };

  const [row] = await run<{ applications: number; shortlisted: number }>(
    `SELECT COUNT(*)::int AS applications,
       COUNT(*) FILTER (WHERE a.status = $3)::int AS shortlisted
     FROM applications a JOIN jobs j ON j.id = a.job_id
     WHERE j.organization_id = $1 AND a."applicationType" = $2`,
    [organizationId, ApplicationType.Application, ApplicationStatus.Shortlisted]
  );
  return { applications: row?.applications ?? 0, shortlisted: row?.shortlisted ?? 0 };
};
