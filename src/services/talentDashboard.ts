import { AppDataSource } from "../database/dataSource.js";
import { JobStatus } from "../types/enums.js";
import { convertSimilarityToPercentage } from "../utils/text.js";
import {
  buildCandidatePipelines,
  loadTalentApplications,
  type PipelineStep,
} from "./candidatePipeline.js";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const TALENT_MATCH_LIMIT = 4;
export const DEFAULT_MIN_MATCH_PERCENT = 50;

export interface TalentJobMatch {
  jobId: string;
  title: string;
  company: string | null;
  companyLogoUrl: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  workMode: string[];
  createdAt: Date;
  matchPercent: number;
}

export interface TalentTodo {
  applicationId: string;
  jobId: string;
  jobTitle: string;
  company: { name: string; logoUrl: string | null } | null;
  step: PipelineStep;
}

export interface TalentApplicationSummary {
  applications: { sent: number; sentThisWeek: number };
  tests: { toTake: number; nextDueAt: string | null };
  interviews: { toRecord: number; nextDueAt: string | null };
  todo: TalentTodo[];
}

export interface TalentDashboard extends TalentApplicationSummary {
  cvReady: boolean;
  matches: TalentJobMatch[];
  newMatchesToday: number;
}

const earliest = (dates: Array<string | null>): string | null =>
  dates.filter((date): date is string => !!date).sort()[0] ?? null;

export const getTalentApplicationSummary = async (
  talentId: string
): Promise<TalentApplicationSummary> => {
  const applications = await loadTalentApplications(talentId);
  const pipelines = await buildCandidatePipelines(talentId, applications);
  const weekAgo = Date.now() - WEEK_MS;

  const todo: TalentTodo[] = pipelines
    .filter((pipeline) => pipeline.application.group === "needs_you" && pipeline.nextStep)
    .map((pipeline) => ({
      applicationId: pipeline.application.id,
      jobId: pipeline.application.jobId,
      jobTitle: pipeline.application.job.title,
      company: pipeline.application.job.organization
        ? {
            name: pipeline.application.job.organization.name,
            logoUrl: pipeline.application.job.organization.logoUrl,
          }
        : null,
      step: pipeline.nextStep!,
    }))
    .sort((a, b) => (a.step.dueAt ?? "~").localeCompare(b.step.dueAt ?? "~"));

  const tests = todo.filter((item) => item.step.key !== "ai_interview");
  const interviews = todo.filter((item) => item.step.key === "ai_interview");

  return {
    applications: {
      sent: pipelines.length,
      sentThisWeek: pipelines.filter(
        (pipeline) => new Date(pipeline.application.appliedAt).getTime() >= weekAgo
      ).length,
    },
    tests: { toTake: tests.length, nextDueAt: earliest(tests.map((item) => item.step.dueAt)) },
    interviews: {
      toRecord: interviews.length,
      nextDueAt: earliest(interviews.map((item) => item.step.dueAt)),
    },
    todo,
  };
};

const toMatchPercent = (distance: number): number =>
  convertSimilarityToPercentage(Math.min(Math.max(distance, 0), 1));

export const getTalentDashboard = async (talentId: string): Promise<TalentDashboard> => ({
  ...(await getTalentApplicationSummary(talentId)),
  ...(await getTalentMatches(talentId)),
});

const getTalentMatches = async (
  talentId: string
): Promise<Pick<TalentDashboard, "cvReady" | "matches" | "newMatchesToday">> => {
  const [readyRow] = (await AppDataSource.query(
    `SELECT EXISTS (
       SELECT 1 FROM talent_embeddings WHERE user_id = $1 AND cv_embedding IS NOT NULL
     ) AS ready`,
    [talentId]
  )) as Array<{ ready: boolean }>;

  if (!readyRow?.ready) return { cvReady: false, matches: [], newMatchesToday: 0 };

  const rows = (await AppDataSource.query(
    `WITH chunks AS (
       SELECT cv_embedding::vector AS embedding
       FROM talent_embeddings
       WHERE user_id = $1 AND cv_embedding IS NOT NULL
     ),
     eligible AS (
       SELECT j.id, j."createdAt" AS created_at, c."minCvSimilarityScore" AS min_score,
         j.job_embedding::vector AS embedding
       FROM jobs j
       JOIN ai_configs c ON c.id = j.ai_config_id
       WHERE j.status = $2
         AND j.job_embedding IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM applications a WHERE a.job_id = j.id AND a.talent_id = $1
         )
     ),
     scored AS (
       SELECT e.id, e.created_at, e.min_score, MIN(ch.embedding <=> e.embedding) AS distance
       FROM eligible e
       JOIN chunks ch ON vector_dims(ch.embedding) = vector_dims(e.embedding)
       GROUP BY e.id, e.created_at, e.min_score
     ),
     valid AS (
       SELECT * FROM scored WHERE distance IS NOT NULL AND distance <> 'NaN'::float8
     )
     SELECT v.id, v.distance::float8 AS distance,
       r.name AS title, o.name AS company, o.logo_url AS company_logo_url,
       j."locationCity" AS city, j."locationState" AS state, j."locationCountry" AS country,
       j."workMode" AS work_mode, j."createdAt" AS created_at,
       (SELECT COUNT(*)::int FROM valid n
         WHERE n.created_at >= LOCALTIMESTAMP - interval '24 hours'
           AND (1 - LEAST(GREATEST(n.distance, 0), 1)) * 100 >= COALESCE(n.min_score, $4)
       ) AS new_today
     FROM valid v
     JOIN jobs j ON j.id = v.id
     JOIN roles r ON r.id = j.role_id
     LEFT JOIN organizations o ON o.id = j.organization_id
     ORDER BY v.distance ASC, v.created_at DESC, v.id ASC
     LIMIT $3`,
    [talentId, JobStatus.Active, TALENT_MATCH_LIMIT, DEFAULT_MIN_MATCH_PERCENT]
  )) as Array<{
    id: string;
    distance: number;
    title: string;
    company: string | null;
    company_logo_url: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    work_mode: string | null;
    created_at: Date;
    new_today: number;
  }>;

  return {
    cvReady: true,
    matches: rows.map((row) => ({
      jobId: row.id,
      title: row.title,
      company: row.company,
      companyLogoUrl: row.company_logo_url,
      city: row.city,
      state: row.state,
      country: row.country,
      workMode: row.work_mode ? row.work_mode.split(",").filter(Boolean) : [],
      createdAt: row.created_at,
      matchPercent: toMatchPercent(Number(row.distance)),
    })),
    newMatchesToday: rows[0]?.new_today ?? 0,
  };
};
