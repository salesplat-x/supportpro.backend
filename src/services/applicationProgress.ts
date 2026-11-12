import { AppDataSource } from "../database/dataSource.js";
import { ApplicationStatus } from "../types/enums.js";

export const BOARD_COLUMNS = [
  "applied",
  "cv_matched",
  "pre_screened",
  "personality_test",
  "shortlisted",
] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

export const PROGRESS_STAGES = [
  "applied",
  "cv_matched",
  "pre_screened",
  "personality_test",
  "interview",
] as const;
export type ProgressStage = (typeof PROGRESS_STAGES)[number];

export const INTERVIEW_PROGRESS = ["not_started", "in_progress", "processing", "ready"] as const;
export type InterviewProgress = (typeof INTERVIEW_PROGRESS)[number];

export const OFF_BOARD_STATUSES = [ApplicationStatus.Rejected, ApplicationStatus.NotProceeding];

const col = (alias: string, name: string) => `"${alias}"."${name}"`;

const testStageSql = (a: string, u: string) => `CASE
    WHEN ${col(a, "mbtiType")} IS NOT NULL THEN 'personality_test'
    WHEN ${col(u, "prescreeningScore")} IS NOT NULL THEN 'pre_screened'
    WHEN ${col(a, "cvSimilarityScore")} IS NOT NULL THEN 'cv_matched'
    ELSE 'applied'
  END`;

const interviewStartedSql = (i: string) =>
  `(${col(i, "id")} IS NOT NULL AND ${col(i, "status")} != 'failed')`;

/** Furthest step an application has reached, ignoring the recruiter's decision. */
export const progressStageSql = (a: string, u: string, i: string) =>
  `CASE WHEN ${interviewStartedSql(i)} THEN 'interview' ELSE ${testStageSql(a, u)} END`;

/** Board column, or NULL for rejected applications, which the board leaves out. */
export const boardColumnSql = (a: string, u: string) => `CASE
    WHEN ${col(a, "status")} IN (${OFF_BOARD_STATUSES.map((s) => `'${s}'`).join(", ")}) THEN NULL
    WHEN ${col(a, "status")} = '${ApplicationStatus.Shortlisted}' THEN 'shortlisted'
    ELSE ${testStageSql(a, u)}
  END`;

/**
 * Not started until the candidate is invited or records an answer; processing once every
 * question has a recording but the scores are not in yet.
 */
export const interviewProgressSql = (i: string) => `CASE
    WHEN NOT ${interviewStartedSql(i)} THEN 'not_started'
    WHEN ${col(i, "scoring_status")} = 'completed' THEN 'ready'
    WHEN EXISTS (SELECT 1 FROM "ai_interview_questions" q WHERE q."interview_id" = ${col(i, "id")})
      AND NOT EXISTS (
        SELECT 1 FROM "ai_interview_questions" q
        WHERE q."interview_id" = ${col(i, "id")} AND q."recorded_at" IS NULL
      ) THEN 'processing'
    WHEN ${col(i, "invited_at")} IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM "ai_interview_questions" q
        WHERE q."interview_id" = ${col(i, "id")} AND q."recorded_at" IS NOT NULL
      ) THEN 'in_progress'
    ELSE 'not_started'
  END`;

export interface ApplicationProgress {
  stage: ProgressStage;
  boardColumn: BoardColumn | null;
  interview: { id: string | null; status: InterviewProgress };
}

export const NO_PROGRESS: ApplicationProgress = {
  stage: "applied",
  boardColumn: null,
  interview: { id: null, status: "not_started" },
};

export const loadApplicationProgress = async (
  applicationIds: string[]
): Promise<Map<string, ApplicationProgress>> => {
  if (applicationIds.length === 0) return new Map();
  const rows = (await AppDataSource.query(
    `SELECT a.id,
       ${progressStageSql("a", "u", "i")} AS stage,
       ${boardColumnSql("a", "u")} AS board_column,
       ${interviewProgressSql("i")} AS interview_status,
       CASE WHEN ${interviewStartedSql("i")} THEN i.id ELSE NULL END AS interview_id
     FROM applications a
     LEFT JOIN users u ON u.id = a.talent_id
     LEFT JOIN ai_interviews i ON i.application_id = a.id
     WHERE a.id = ANY($1::uuid[])`,
    [applicationIds]
  )) as Array<{
    id: string;
    stage: ProgressStage;
    board_column: BoardColumn | null;
    interview_status: InterviewProgress;
    interview_id: string | null;
  }>;
  return new Map(
    rows.map((row) => [
      row.id,
      {
        stage: row.stage,
        boardColumn: row.board_column,
        interview: { id: row.interview_id, status: row.interview_status },
      },
    ])
  );
};
