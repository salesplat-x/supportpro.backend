import { AppDataSource } from "../database/dataSource.js";
import { ApplicationStatus, ScreeningStage } from "../types/enums.js";

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

export const VERIFICATION_STATES = ["none", "pending", "flagged", "failed", "verified"] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

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
 * Not started until the candidate is invited or records an answer; processing once every main
 * question has a recording but the scores are not in yet. An unanswered follow-up never holds
 * an interview back.
 */
export const interviewProgressSql = (i: string) => `CASE
    WHEN NOT ${interviewStartedSql(i)} THEN 'not_started'
    WHEN ${col(i, "scoring_status")} = 'completed' THEN 'ready'
    WHEN EXISTS (SELECT 1 FROM "ai_interview_questions" q WHERE q."interview_id" = ${col(i, "id")})
      AND NOT EXISTS (
        SELECT 1 FROM "ai_interview_questions" q
        WHERE q."interview_id" = ${col(i, "id")} AND q."recorded_at" IS NULL
          AND NOT q."is_follow_up"
      ) THEN 'processing'
    WHEN ${col(i, "invited_at")} IS NOT NULL
      OR EXISTS (
        SELECT 1 FROM "ai_interview_questions" q
        WHERE q."interview_id" = ${col(i, "id")} AND q."recorded_at" IS NOT NULL
      ) THEN 'in_progress'
    ELSE 'not_started'
  END`;

/**
 * An interview that can't be scored: scoring gave up, or every main answer is in and none could
 * be turned into text. It stays "processing" in the status, which older pages already know.
 */
export const interviewFailedSql = (i: string) => `COALESCE(
    ${col(i, "scoring_status")} = 'failed'
    OR (
      EXISTS (SELECT 1 FROM "ai_interview_questions" q WHERE q."interview_id" = ${col(i, "id")})
      AND NOT EXISTS (
        SELECT 1 FROM "ai_interview_questions" q
        WHERE q."interview_id" = ${col(i, "id")}
          AND ((q."recorded_at" IS NULL AND NOT q."is_follow_up") OR q."transcript_status" = 'pending')
      )
      AND NOT EXISTS (
        SELECT 1 FROM "ai_interview_questions" q
        WHERE q."interview_id" = ${col(i, "id")} AND q."transcript_status" = 'completed'
      )
    ),
    false
  )`;

const mainQuestionsSql = (i: string, extra = "") =>
  `SELECT 1 FROM "ai_interview_questions" q
   WHERE q."interview_id" = ${col(i, "id")} AND NOT q."is_follow_up"${extra}`;

/** Every main question of a started interview has a recording; an interview still being written has none yet. */
const interviewRecordedSql = (i: string) =>
  `(${interviewStartedSql(i)} AND EXISTS (${mainQuestionsSql(i)})
    AND NOT EXISTS (${mainQuestionsSql(i, ` AND q."recorded_at" IS NULL`)}))`;

const runsInterviewSql = (c: string) =>
  `COALESCE(${col(c, "aiInterview")} AND ${col(c, "aiInterviewMode")} IS NOT NULL, false)`;

/**
 * Every screening step is behind the candidate. Nothing moves an application past the interview
 * stage, so sitting there with the interview recorded (or with none to record) counts as done.
 */
const screeningDoneSql = (a: string, c: string, i: string) =>
  `(${col(a, "currentStage")} = '${ScreeningStage.Completed}'
    OR (${col(a, "currentStage")} = '${ScreeningStage.AiInterview}'
      AND (NOT ${runsInterviewSql(c)} OR ${interviewRecordedSql(i)})))`;

/** An interview a recruiter started outside the candidate's stages must be recorded too. */
const interviewSettledSql = (i: string) =>
  `(NOT ${interviewStartedSql(i)} OR ${interviewRecordedSql(i)})`;

const hasRefereeSql = (a: string) =>
  `EXISTS (SELECT 1 FROM "application_references" r WHERE r."application_id" = ${col(a, "id")})`;

/** The candidate finished every application step, so the company can review and shortlist them. */
export const readyForReviewSql = (a: string, c: string, i: string) =>
  `(${screeningDoneSql(a, c, i)} AND ${interviewSettledSql(i)} AND ${hasRefereeSql(a)})`;

const waitingForSql = (a: string, c: string, i: string) => `CASE
    WHEN NOT ${screeningDoneSql(a, c, i)} THEN ${col(a, "currentStage")}::text
    WHEN NOT ${interviewSettledSql(i)} THEN '${ScreeningStage.AiInterview}'
    WHEN NOT ${hasRefereeSql(a)} THEN 'references'
    ELSE NULL
  END`;

/** "Move forward" may start the interview: the job runs one, there's none, and the steps before it are done. */
const canStartInterviewSql = (a: string, c: string, i: string) =>
  `(${runsInterviewSql(c)} AND NOT ${interviewStartedSql(i)}
    AND ${col(a, "currentStage")} IN ('${ScreeningStage.AiInterview}', '${ScreeningStage.Completed}'))`;

const belowCvMinimumSql = (a: string, c: string) =>
  `COALESCE(${col(a, "cvSimilarityScore")} < ${col(c, "minCvSimilarityScore")}, false)`;

/** One status over every check ordered on the application: failed, flagged, pending, else verified. */
export const verificationSql = (a: string) => `COALESCE((
    SELECT CASE
      WHEN bool_or(c."status" = 'failed') THEN 'failed'
      WHEN bool_or(c."status" = 'flagged') THEN 'flagged'
      WHEN bool_or(c."status" = 'pending') THEN 'pending'
      ELSE 'verified'
    END
    FROM "application_checks" c
    WHERE c."application_id" = ${col(a, "id")}
    HAVING COUNT(*) > 0
  ), 'none')`;

export type WaitingFor = ScreeningStage | "references";

export interface ApplicationProgress {
  stage: ProgressStage;
  boardColumn: BoardColumn | null;
  interview: { id: string | null; status: InterviewProgress; failed: boolean };
  verification: VerificationState;
  readyForReview: boolean;
  waitingFor: WaitingFor | null;
  canStartInterview: boolean;
  belowCvMinimum: boolean;
}

export const NO_PROGRESS: ApplicationProgress = {
  stage: "applied",
  boardColumn: null,
  interview: { id: null, status: "not_started", failed: false },
  verification: "none",
  readyForReview: false,
  waitingFor: null,
  canStartInterview: false,
  belowCvMinimum: false,
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
       ${interviewFailedSql("i")} AS interview_failed,
       CASE WHEN ${interviewStartedSql("i")} THEN i.id ELSE NULL END AS interview_id,
       ${verificationSql("a")} AS verification,
       ${readyForReviewSql("a", "c", "i")} AS ready_for_review,
       ${waitingForSql("a", "c", "i")} AS waiting_for,
       ${canStartInterviewSql("a", "c", "i")} AS can_start_interview,
       ${belowCvMinimumSql("a", "c")} AS below_cv_minimum
     FROM applications a
     LEFT JOIN users u ON u.id = a.talent_id
     LEFT JOIN ai_interviews i ON i.application_id = a.id
     LEFT JOIN jobs j ON j.id = a.job_id
     LEFT JOIN ai_configs c ON c.id = j.ai_config_id
     WHERE a.id = ANY($1::uuid[])`,
    [applicationIds]
  )) as Array<{
    id: string;
    stage: ProgressStage;
    board_column: BoardColumn | null;
    interview_status: InterviewProgress;
    interview_failed: boolean;
    interview_id: string | null;
    verification: VerificationState;
    ready_for_review: boolean;
    waiting_for: WaitingFor | null;
    can_start_interview: boolean;
    below_cv_minimum: boolean;
  }>;
  return new Map(
    rows.map((row) => [
      row.id,
      {
        stage: row.stage,
        boardColumn: row.board_column,
        interview: {
          id: row.interview_id,
          status: row.interview_status,
          failed: row.interview_failed,
        },
        verification: row.verification,
        readyForReview: row.ready_for_review,
        waitingFor: row.waiting_for,
        canStartInterview: row.can_start_interview,
        belowCvMinimum: row.below_cv_minimum,
      },
    ])
  );
};
