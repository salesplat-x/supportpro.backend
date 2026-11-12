import { AppDataSource } from "../database/dataSource.js";
import { Job } from "../entities/Job.js";
import { ApplicationStatus, UserRole } from "../types/enums.js";
import { NotFoundError } from "../utils/errors";
import { boardColumnSql, BOARD_COLUMNS, type BoardColumn } from "./applicationProgress.js";
import { assertRecruiterJobAccess } from "./job.js";

const WEEK = `NOW() - INTERVAL '7 days'`;
const ACTIVITY_LIMIT = 4;

export type JobActivityType =
  "posted" | "matched" | "shortlisted" | "rejected" | "interview_invited" | "interview_finished";

export interface JobSummary {
  applicants: { total: number; thisWeek: number };
  passRate: {
    value: number | null;
    passed: number;
    preScreened: number;
    deltaVsLastPost: number | null;
  };
  avgCvMatch: { value: number | null; deltaThisWeek: number | null };
  shortlisted: { count: number; pctOfApplicants: number };
  pipeline: {
    applied: number;
    cvMatched: number;
    preScreened: number;
    personalityTest: number;
    interview: number;
  };
  board: Record<BoardColumn, number>;
  topSkills: Array<{ skill: string; pct: number }>;
  recentActivity: Array<{ type: JobActivityType; title: string; at: Date }>;
  hiringTeam: Array<{ userId: string; name: string; role: string; isOwner: boolean }>;
  keyDates: {
    postedAt: Date;
    postedBy: string | null;
    closesAt: string | null;
    interviewsStartAt: Date | null;
  };
}

const run = <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
  AppDataSource.query(sql, params) as Promise<T[]>;

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

const round = (value: number | string | null) =>
  value === null ? null : Math.round(Number(value));

const fullName = (first: string | null, last: string | null) =>
  `${first ?? ""} ${last ?? ""}`.trim() || "A candidate";

const passRateFor = async (jobId: string): Promise<{ passed: number; preScreened: number }> => {
  const [row] = await run<{ passed: number; pre_screened: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE u."prescreeningScore" IS NOT NULL)::int AS pre_screened,
       COUNT(*) FILTER (
         WHERE u."prescreeningScore" >= COALESCE(c."minPrescreeningScore", 0)
       )::int AS passed
     FROM applications a
     JOIN jobs j ON j.id = a.job_id
     LEFT JOIN ai_configs c ON c.id = j.ai_config_id
     LEFT JOIN users u ON u.id = a.talent_id
     WHERE a.job_id = $1`,
    [jobId]
  );
  return { passed: row?.passed ?? 0, preScreened: row?.pre_screened ?? 0 };
};

const previousJobId = async (job: Job): Promise<string | null> => {
  const [row] = await run<{ id: string }>(
    `SELECT id FROM jobs
     WHERE id != $1 AND "createdAt" < $2
       AND ${job.organizationId ? "organization_id = $3" : "posted_by_id = $3"}
     ORDER BY "createdAt" DESC LIMIT 1`,
    [job.id, job.createdAt, job.organizationId ?? job.postedById]
  );
  return row?.id ?? null;
};

const loadActivity = async (job: Job, postedBy: string | null) => {
  const [decisions, interviews, matched] = await Promise.all([
    run<{ first: string | null; last: string | null; status: string; at: Date }>(
      `SELECT u."firstName" AS first, u."lastName" AS last, a.status, a."updatedAt" AS at
       FROM applications a JOIN users u ON u.id = a.talent_id
       WHERE a.job_id = $1 AND a.status IN ($2, $3)
       ORDER BY a."updatedAt" DESC LIMIT $4`,
      [job.id, ApplicationStatus.Shortlisted, ApplicationStatus.Rejected, ACTIVITY_LIMIT]
    ),
    run<{
      first: string | null;
      last: string | null;
      invited_at: Date | null;
      finished_at: Date | null;
    }>(
      `SELECT u."firstName" AS first, u."lastName" AS last, i.invited_at,
         CASE WHEN NOT EXISTS (
           SELECT 1 FROM ai_interview_questions q WHERE q.interview_id = i.id AND q.recorded_at IS NULL
         ) THEN (SELECT MAX(q.recorded_at) FROM ai_interview_questions q WHERE q.interview_id = i.id)
         END AS finished_at
       FROM ai_interviews i JOIN users u ON u.id = i.talent_id
       WHERE i.job_id = $1 AND i.status != 'failed'
       ORDER BY GREATEST(i.invited_at, i.updated_at) DESC NULLS LAST LIMIT $2`,
      [job.id, ACTIVITY_LIMIT]
    ),
    run<{ count: number; at: Date | null }>(
      `SELECT COUNT(*)::int AS count, MAX("createdAt") AS at
       FROM applications
       WHERE job_id = $1 AND "createdAt" >= ${WEEK} AND "cvSimilarityScore" IS NOT NULL`,
      [job.id]
    ),
  ]);

  const items: JobSummary["recentActivity"] = [];
  for (const row of decisions) {
    const name = fullName(row.first, row.last);
    items.push(
      row.status === ApplicationStatus.Shortlisted
        ? { type: "shortlisted", title: `${name} was moved to Shortlisted`, at: row.at }
        : { type: "rejected", title: `${name} was rejected`, at: row.at }
    );
  }
  for (const row of interviews) {
    const name = fullName(row.first, row.last);
    if (row.finished_at) {
      items.push({
        type: "interview_finished",
        title: `${name} finished the recorded AI interview`,
        at: row.finished_at,
      });
    } else if (row.invited_at) {
      items.push({
        type: "interview_invited",
        title: `${name} was invited to the recorded AI interview`,
        at: row.invited_at,
      });
    }
  }
  const weekMatches = matched[0];
  if (weekMatches && weekMatches.count > 0 && weekMatches.at) {
    const noun = weekMatches.count === 1 ? "applicant" : "applicants";
    items.push({
      type: "matched",
      title: `AI matched ${weekMatches.count} new ${noun} to this role this week`,
      at: weekMatches.at,
    });
  }
  items.push({
    type: "posted",
    title: postedBy ? `Job posted by ${postedBy}` : "Job posted",
    at: job.createdAt,
  });

  return items
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, ACTIVITY_LIMIT);
};

const loadHiringTeam = async (job: Job): Promise<JobSummary["hiringTeam"]> => {
  const rows = job.organizationId
    ? await run<{ user_id: string; first: string | null; last: string | null; role: string }>(
        `SELECT m.user_id, u."firstName" AS first, u."lastName" AS last, m.role
         FROM organization_members m JOIN users u ON u.id = m.user_id
         WHERE m.organization_id = $1
         ORDER BY (m.user_id = $2) DESC, (m.role = 'owner') DESC, u."firstName" ASC`,
        [job.organizationId, job.postedById]
      )
    : await run<{ user_id: string; first: string | null; last: string | null; role: string }>(
        `SELECT u.id AS user_id, u."firstName" AS first, u."lastName" AS last, 'owner' AS role
         FROM users u WHERE u.id = $1`,
        [job.postedById]
      );
  return rows.map((row) => ({
    userId: row.user_id,
    name: fullName(row.first, row.last),
    role: row.role,
    isOwner: row.user_id === job.postedById,
  }));
};

export const getJobSummary = async (
  userId: string,
  userRole: UserRole,
  jobId: string
): Promise<JobSummary> => {
  const job = await AppDataSource.getRepository(Job).findOne({
    where: { id: jobId },
    relations: { postedBy: true },
  });
  if (!job) throw new NotFoundError("Job not found");
  await assertRecruiterJobAccess(userId, userRole, job);

  const postedBy = job.postedBy ? fullName(job.postedBy.firstName, job.postedBy.lastName) : null;
  const lastJobId = await previousJobId(job);

  const [
    totalsRows,
    boardRows,
    skillRows,
    firstInvite,
    current,
    previous,
    recentActivity,
    hiringTeam,
  ] = await Promise.all([
    run<Record<string, number | string | null>>(
      `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE a."createdAt" >= ${WEEK})::int AS this_week,
           AVG(a."cvSimilarityScore") AS avg_cv,
           AVG(a."cvSimilarityScore") FILTER (WHERE a."createdAt" < ${WEEK}) AS avg_cv_before_week,
           COUNT(*) FILTER (WHERE a.status = $2)::int AS shortlisted,
           COUNT(*) FILTER (WHERE a."cvSimilarityScore" IS NOT NULL)::int AS cv_matched,
           COUNT(*) FILTER (WHERE u."prescreeningScore" IS NOT NULL)::int AS pre_screened,
           COUNT(*) FILTER (WHERE a."mbtiType" IS NOT NULL)::int AS personality_test,
           COUNT(i.id) FILTER (WHERE i.status != 'failed')::int AS interview
         FROM applications a
         LEFT JOIN users u ON u.id = a.talent_id
         LEFT JOIN ai_interviews i ON i.application_id = a.id
         WHERE a.job_id = $1`,
      [jobId, ApplicationStatus.Shortlisted]
    ),
    run<{ board_column: BoardColumn | null; count: number }>(
      `SELECT ${boardColumnSql("a", "u")} AS board_column, COUNT(*)::int AS count
         FROM applications a LEFT JOIN users u ON u.id = a.talent_id
         WHERE a.job_id = $1 GROUP BY 1`,
      [jobId]
    ),
    job.skills?.length
      ? run<{ skill: string; matched: number; total: number }>(
          `SELECT s.skill,
               COUNT(a.id) FILTER (WHERE jsonb_typeof(u.cv_skills) = 'array' AND EXISTS (
                 SELECT 1 FROM jsonb_array_elements_text(u.cv_skills) x WHERE lower(x) = lower(s.skill)
               ))::int AS matched,
               COUNT(a.id)::int AS total
             FROM unnest($2::text[]) WITH ORDINALITY AS s(skill, ord)
             LEFT JOIN applications a ON a.job_id = $1
             LEFT JOIN users u ON u.id = a.talent_id
             GROUP BY s.skill, s.ord ORDER BY s.ord`,
          [jobId, job.skills]
        )
      : Promise.resolve([]),
    run<{ at: Date | null }>(`SELECT MIN(invited_at) AS at FROM ai_interviews WHERE job_id = $1`, [
      jobId,
    ]),
    passRateFor(jobId),
    lastJobId ? passRateFor(lastJobId) : Promise.resolve(null),
    loadActivity(job, postedBy),
    loadHiringTeam(job),
  ]);

  const totals = totalsRows[0] ?? {};
  const count = (key: string) => Number(totals[key] ?? 0);
  const total = count("total");
  const avgCv = round(totals["avg_cv"] ?? null);
  const avgCvBeforeWeek = round(totals["avg_cv_before_week"] ?? null);
  const passRate = current.preScreened > 0 ? pct(current.passed, current.preScreened) : null;
  const previousPassRate =
    previous && previous.preScreened > 0 ? pct(previous.passed, previous.preScreened) : null;

  const board = Object.fromEntries(BOARD_COLUMNS.map((column) => [column, 0])) as Record<
    BoardColumn,
    number
  >;
  for (const row of boardRows) {
    if (row.board_column) board[row.board_column] = Number(row.count);
  }

  return {
    applicants: { total, thisWeek: count("this_week") },
    passRate: {
      value: passRate,
      passed: current.passed,
      preScreened: current.preScreened,
      deltaVsLastPost:
        passRate !== null && previousPassRate !== null ? passRate - previousPassRate : null,
    },
    avgCvMatch: {
      value: avgCv,
      deltaThisWeek: avgCv !== null && avgCvBeforeWeek !== null ? avgCv - avgCvBeforeWeek : null,
    },
    shortlisted: { count: count("shortlisted"), pctOfApplicants: pct(count("shortlisted"), total) },
    pipeline: {
      applied: total,
      cvMatched: count("cv_matched"),
      preScreened: count("pre_screened"),
      personalityTest: count("personality_test"),
      interview: count("interview"),
    },
    board,
    topSkills: skillRows.map((row) => ({ skill: row.skill, pct: pct(row.matched, row.total) })),
    recentActivity,
    hiringTeam,
    keyDates: {
      postedAt: job.createdAt,
      postedBy,
      closesAt: job.closesAt,
      interviewsStartAt: firstInvite[0]?.at ?? null,
    },
  };
};
