import crypto from "crypto";
import { AppDataSource } from "../database/dataSource.js";
import { Scout } from "../entities/Scout.js";
import { ScoutJob } from "../entities/ScoutJob.js";
import { ScoutRun } from "../entities/ScoutRun.js";
import { NotFoundError, ValidationError } from "../utils/errors";
import { ScoutCvStatus, ScoutRunStatus, UserRole } from "../types/enums.js";
import {
  MAX_CV_CHARS,
  MAX_SHORTLIST_SIZE,
  MIN_SHORTLIST_SIZE,
  RUN_CONCURRENCY,
} from "../config/scout.js";
import { createLimiter } from "../utils/concurrencyLimiter.js";
import {
  MAX_DURABLE_ATTEMPTS,
  STALE_LOCK_INTERVAL,
  SWEEP_BATCH_SIZE,
  claimRowById,
  durableFailureUpdate,
  selectDueIds,
} from "../utils/durableJobs.js";
import { extractText, preprocessText } from "../utils/text.js";
import {
  getFromSpaces,
  spacesKeyFor,
  uploadPrivateToSpaces,
} from "../utils/integrations/spaces.js";
import { scoutAssessCandidate, scoutShortlistSummary } from "../utils/integrations/openai.js";
import logger from "../utils/logger.js";
import { assertCompanyResourceAccess } from "./organizationScope.js";
import { formatAssessmentInsights, parseScoutAssessment } from "./scoutAssessment.js";
import { upsertScoutCandidate } from "./scoutCandidate.js";

const scoutRepo = () => AppDataSource.getRepository(Scout);
const runRepo = () => AppDataSource.getRepository(ScoutRun);
const scoutJobRepo = () => AppDataSource.getRepository(ScoutJob);

const hashText = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

export interface StartScoutRunPayload {
  scoutJobId: string;
  idempotencyKey: string;
  files: Express.Multer.File[];
}

export interface StartScoutRunResult {
  run: ScoutRun;
  /** True when this request matched an existing run instead of creating one. */
  deduplicated: boolean;
}

/**
 * Accepts an upload and returns immediately.
 *
 * Files go to Spaces before anything is written to the database, so a storage
 * failure aborts the whole request rather than leaving a run whose CVs can never be
 * read. Because the bytes are durable first, the worker can fetch them back later —
 * which is what lets a run survive a restart mid-scoring.
 */
export const startScoutRun = async (
  userId: string,
  payload: StartScoutRunPayload
): Promise<StartScoutRunResult> => {
  const job = await scoutJobRepo().findOne({ where: { id: payload.scoutJobId } });
  if (!job) {
    throw new NotFoundError("Scout campaign not found");
  }
  await assertCompanyResourceAccess(userId, UserRole.Recruiter, job.organizationId, job.postedById);

  // A retried submit must not re-upload to Spaces or re-charge the plan, so the
  // idempotency check comes before any side effect.
  const existing = await runRepo().findOne({
    where: { scoutJobId: job.id, idempotencyKey: payload.idempotencyKey },
  });
  if (existing) {
    return { run: existing, deduplicated: true };
  }

  const uploadLimiter = createLimiter(5);
  const uploaded = await Promise.all(
    payload.files.map((file) =>
      uploadLimiter.run(async () => {
        const key = spacesKeyFor("scout-cvs", job.id, file.originalname);
        await uploadPrivateToSpaces(file.buffer, key, file.mimetype);
        return { file, key };
      })
    )
  );

  const shortlistSize = clampShortlistSize(job.shortlistSize);

  try {
    const run = await AppDataSource.transaction(async (manager) => {
      const created = await manager.getRepository(ScoutRun).save(
        manager.getRepository(ScoutRun).create({
          scoutJobId: job.id,
          recruiterId: userId,
          organizationId: job.organizationId,
          idempotencyKey: payload.idempotencyKey,
          status: ScoutRunStatus.Processing,
          totalCvs: uploaded.length,
          shortlistSize,
        })
      );

      const rows = uploaded.map(({ file, key }, index) =>
        manager.getRepository(Scout).create({
          scoutJobId: job.id,
          scoutRunId: created.id,
          recruiterId: userId,
          cvName: file.originalname.replace(/\.[^.]+$/, ""),
          cvFileKey: key,
          cvMimeType: file.mimetype,
          cvFileSize: file.size,
          position: index,
          status: ScoutCvStatus.Queued,
        })
      );
      await manager.getRepository(Scout).save(rows);

      return created;
    });

    scheduleRun(run.id);
    return { run, deduplicated: false };
  } catch (err) {
    // Two requests with the same key can race past the check above; the unique
    // index is the real guard, so treat a conflict as the duplicate it is.
    const conflict = await runRepo().findOne({
      where: { scoutJobId: job.id, idempotencyKey: payload.idempotencyKey },
    });
    if (conflict) {
      return { run: conflict, deduplicated: true };
    }
    throw err;
  }
};

const clampShortlistSize = (size: number): number =>
  Math.min(Math.max(size, MIN_SHORTLIST_SIZE), MAX_SHORTLIST_SIZE);

const inFlightRuns = new Set<Promise<void>>();

/** Await fire-and-forget run processing before asserting on it, or tearing down the test DB. */
export const drainInFlightScoutRuns = async (): Promise<void> => {
  for (let attempt = 0; attempt < 100 && inFlightRuns.size > 0; attempt++) {
    await Promise.allSettled([...inFlightRuns]);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

const scheduleRun = (runId: string): void => {
  const task = new Promise<void>((resolve) => {
    setImmediate(() => {
      processScoutRun(runId)
        .catch((err: unknown) => {
          logger.error(
            `Scout run ${runId} failed: ${err instanceof Error ? err.message : String(err)}`
          );
        })
        .finally(resolve);
    });
  }).finally(() => inFlightRuns.delete(task));
  inFlightRuns.add(task);
};

/**
 * Scores every queued CV in a run, then finalizes it. Safe to call repeatedly and
 * from more than one place at once — each CV is claimed with a conditional UPDATE,
 * so a second caller simply finds nothing left to do.
 */
export const processScoutRun = async (runId: string): Promise<void> => {
  const rows = await scoutRepo().find({
    where: { scoutRunId: runId },
    select: { id: true },
    order: { position: "ASC" },
  });

  const limiter = createLimiter(RUN_CONCURRENCY);
  await Promise.allSettled(rows.map((row) => limiter.run(() => processScoutCv(row.id))));

  await finalizeRun(runId);
};

/**
 * `processing` is claimable too, but only once its lock has gone stale — that is how
 * a CV abandoned by a crashed process gets picked up again. The stale-lock condition
 * is what stops a second worker stealing a row that is genuinely still in flight.
 */
const CLAIM_SCOUT_CV_SQL = `
  UPDATE "scouts"
  SET "status" = 'processing',
      "locked_at" = NOW()
  WHERE "id" = $1
    AND "status" IN ('queued', 'failed', 'processing')
    AND "attempts" < ${MAX_DURABLE_ATTEMPTS}
    AND ("next_retry_at" IS NULL OR "next_retry_at" <= NOW())
    AND ("locked_at" IS NULL OR "locked_at" < NOW() - INTERVAL '${STALE_LOCK_INTERVAL}')
  RETURNING "id"
`;

const DUE_SCOUT_CV_SQL = `
  SELECT "id" FROM "scouts"
  WHERE "cv_file_key" IS NOT NULL
    AND "status" IN ('queued', 'processing', 'failed')
    AND "attempts" < $1
    AND ("next_retry_at" IS NULL OR "next_retry_at" <= NOW())
    AND ("locked_at" IS NULL OR "locked_at" < NOW() - INTERVAL '${STALE_LOCK_INTERVAL}')
  LIMIT $2
`;

const recordCvFailure = async (
  scoutId: string,
  err: unknown,
  options: { permanent?: boolean } = {}
): Promise<void> => {
  const row = await scoutRepo().findOne({
    where: { id: scoutId },
    select: { id: true, attempts: true },
  });
  const patch = options.permanent
    ? {
        attempts: MAX_DURABLE_ATTEMPTS,
        nextRetryAt: null as Date | null,
        lockedAt: null,
        lastError: err instanceof Error ? err.message : String(err),
        exhausted: true,
      }
    : durableFailureUpdate(row?.attempts ?? 0, err);

  await scoutRepo().update(scoutId, {
    status: patch.exhausted ? ScoutCvStatus.Failed : ScoutCvStatus.Queued,
    attempts: patch.attempts,
    nextRetryAt: patch.nextRetryAt,
    lockedAt: patch.lockedAt,
    lastError: patch.lastError,
  });
};

/** A file we will never be able to read — retrying it just wastes the budget. */
class UnreadableCvError extends Error {}

export const processScoutCv = async (scoutId: string): Promise<void> => {
  const claimed = await claimRowById(CLAIM_SCOUT_CV_SQL, scoutId);
  if (!claimed) return;

  try {
    const scout = await scoutRepo().findOne({ where: { id: scoutId } });
    if (!scout?.cvFileKey || !scout.scoutJobId) {
      throw new UnreadableCvError("This upload is missing its stored file");
    }

    const job = await scoutJobRepo().findOne({
      where: { id: scout.scoutJobId },
      relations: { role: true },
    });
    if (!job) {
      // The campaign was deleted mid-run; the cascade will remove this row.
      return;
    }

    const buffer = await getFromSpaces(scout.cvFileKey);
    let extracted: string;
    try {
      extracted = await extractText(buffer, scout.cvMimeType ?? "application/pdf");
    } catch {
      throw new UnreadableCvError(
        "We couldn't read this file — it may be corrupted or password protected. Try re-saving it as a PDF."
      );
    }

    const cvText = preprocessText(extracted);
    if (!cvText) {
      throw new UnreadableCvError(
        "We couldn't read any text from this file — it may be a scanned image. Try a text-based PDF or Word file."
      );
    }

    const assessment = parseScoutAssessment(
      await assess(job, cvText, scout.cvName ?? "this CV"),
      scout.cvName ?? "this CV"
    );

    const candidate = await upsertScoutCandidate({
      details: assessment.candidate,
      cvText,
      cvFileUrl: scout.cvFileUrl,
      cvFileKey: scout.cvFileKey,
      organizationId: job.organizationId,
    });

    await scoutRepo().update(scoutId, {
      status: ScoutCvStatus.Scored,
      cvText: cvText.slice(0, MAX_CV_CHARS),
      cvTextHash: hashText(cvText),
      cvScore: assessment.overallScore,
      evaluationScore: assessment.overallScore,
      insights: formatAssessmentInsights(assessment) || null,
      recommendation: assessment.recommendation,
      candidateName: assessment.candidate.fullName,
      candidateEmail: assessment.candidate.email,
      candidatePhone: assessment.candidate.phone,
      candidateAddress:
        [assessment.candidate.city, assessment.candidate.state, assessment.candidate.country]
          .filter(Boolean)
          .join(", ") || null,
      candidateId: candidate.id,
      lockedAt: null,
      nextRetryAt: null,
      lastError: null,
    });
  } catch (err) {
    await recordCvFailure(scoutId, err, { permanent: err instanceof UnreadableCvError });
    throw err;
  }
};

const assess = async (job: ScoutJob, cvText: string, fileLabel: string): Promise<string> => {
  const location = [job.locationCity, job.locationState, job.locationCountry]
    .filter(Boolean)
    .join(", ");

  const response = await scoutAssessCandidate({
    // Truncated so a very long CV can't overflow the model's context and burn
    // every retry on a request that could never have succeeded.
    cv: cvText.slice(0, MAX_CV_CHARS),
    jobBrief: job.jobBrief,
    recruiterGuide: job.recruiterGuide,
    roleName: job.role?.name ?? "",
    experienceLevel: job.experienceLevel,
    mustHaveSkills: job.mustHaveSkills,
    niceToHaveSkills: job.niceToHaveSkills,
    workMode: job.workMode,
    location: location || null,
  });

  const content = response?.message?.content;
  if (!content) {
    throw new ValidationError(`AI service returned an empty assessment for ${fileLabel}`);
  }
  return content;
};

/**
 * Closes out a run: assigns ranks, marks the shortlist and sets the final status.
 *
 * Idempotent and safe under concurrency. `FOR UPDATE` on the run row serializes
 * competing finalizers, and everything is recomputed from the `scouts` rows rather
 * than from counters, so running it ten times produces the same result as running
 * it once. Nothing is decided while any CV could still succeed.
 */
export const finalizeRun = async (runId: string): Promise<void> => {
  await AppDataSource.transaction(async (manager) => {
    const run = await manager
      .getRepository(ScoutRun)
      .createQueryBuilder("run")
      .setLock("pessimistic_write")
      .where("run.id = :runId", { runId })
      .getOne();
    if (!run) return;

    const rows = await manager.getRepository(Scout).find({
      where: { scoutRunId: runId },
    });

    const outstanding = rows.filter(
      (row) =>
        (row.status === ScoutCvStatus.Queued || row.status === ScoutCvStatus.Processing) &&
        row.attempts < MAX_DURABLE_ATTEMPTS
    );
    if (outstanding.length > 0) return;

    const scored = rows.filter((row) => row.status === ScoutCvStatus.Scored);
    const failed = rows.filter((row) => row.status === ScoutCvStatus.Failed);

    // Fully deterministic: score, then the earlier position in the upload, then id as
    // a final backstop. Persisting the resulting rank means re-sorting the results
    // table can never change what rank a candidate was given.
    const ranked = [...scored].sort((a, b) => {
      const byEvaluation = (b.evaluationScore ?? 0) - (a.evaluationScore ?? 0);
      if (byEvaluation !== 0) return byEvaluation;
      const byCv = (b.cvScore ?? 0) - (a.cvScore ?? 0);
      if (byCv !== 0) return byCv;
      const byPosition =
        (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER);
      if (byPosition !== 0) return byPosition;
      return a.id.localeCompare(b.id);
    });

    const shortlistSize = clampShortlistSize(run.shortlistSize);
    for (const [index, row] of ranked.entries()) {
      await manager.getRepository(Scout).update(row.id, {
        rank: index + 1,
        shortlisted: index < shortlistSize,
      });
    }
    // A CV that never scored has no defensible position in the ranking.
    for (const row of failed) {
      await manager.getRepository(Scout).update(row.id, { rank: null, shortlisted: false });
    }

    let status: ScoutRunStatus;
    if (scored.length === 0) {
      status = ScoutRunStatus.Failed;
    } else if (failed.length > 0) {
      status = ScoutRunStatus.CompletedWithErrors;
    } else {
      status = ScoutRunStatus.Completed;
    }

    await manager.getRepository(ScoutRun).update(runId, {
      status,
      completedAt: new Date(),
    });

    if (scored.length > 0 && !run.shortlistSummary) {
      // Outside the lock would be nicer, but it is one cheap call on ≤10 rows and
      // keeping it here means a summary is never missing from a finished run.
      scheduleShortlistSummary(runId, ranked.slice(0, shortlistSize));
    }
  });
};

const scheduleShortlistSummary = (runId: string, shortlist: Scout[]): void => {
  const task = new Promise<void>((resolve) => {
    setImmediate(() => {
      void (async () => {
        try {
          const run = await runRepo().findOne({
            where: { id: runId },
            relations: { scoutJob: { role: true } },
          });
          if (!run?.scoutJob) return;

          const response = await scoutShortlistSummary({
            roleName: run.scoutJob.role?.name ?? "",
            jobBrief: run.scoutJob.jobBrief,
            candidates: shortlist.map((row, index) => ({
              rank: index + 1,
              name: row.candidateName ?? row.cvName ?? `Candidate ${index + 1}`,
              score: row.evaluationScore ?? 0,
              recommendation: row.recommendation ?? "",
            })),
          });

          const content = response?.message?.content;
          if (!content) return;
          const parsed = JSON.parse(content) as { summary?: unknown };
          if (typeof parsed.summary === "string" && parsed.summary.trim()) {
            await runRepo().update(runId, { shortlistSummary: parsed.summary.trim() });
          }
        } catch (err) {
          // A missing summary is cosmetic — the shortlist itself is already complete.
          logger.error(
            `Scout shortlist summary failed for run ${runId}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        } finally {
          resolve();
        }
      })();
    });
  }).finally(() => inFlightRuns.delete(task));
  inFlightRuns.add(task);
};

/** Puts one exhausted CV back in the queue at the recruiter's request. */
export const retryScoutCv = async (userId: string, scoutId: string): Promise<Scout> => {
  const scout = await scoutRepo().findOne({
    where: { id: scoutId },
    relations: { scoutJob: true },
  });
  if (!scout) {
    throw new NotFoundError("CV not found");
  }
  await assertCompanyResourceAccess(
    userId,
    UserRole.Recruiter,
    scout.scoutJob?.organizationId ?? null,
    scout.recruiterId
  );
  if (scout.status === ScoutCvStatus.Scored) {
    throw new ValidationError("This CV has already been scored");
  }

  await scoutRepo().update(scoutId, {
    status: ScoutCvStatus.Queued,
    attempts: 0,
    nextRetryAt: null,
    lockedAt: null,
    lastError: null,
  });

  if (scout.scoutRunId) {
    await runRepo().update(scout.scoutRunId, {
      status: ScoutRunStatus.Processing,
      completedAt: null,
    });
    scheduleRun(scout.scoutRunId);
  }

  return (await scoutRepo().findOneOrFail({ where: { id: scoutId } })) as Scout;
};

export interface ScoutRunProgress {
  queued: number;
  processing: number;
  scored: number;
  failed: number;
}

export interface ScoutRunDetail {
  run: ScoutRun;
  progress: ScoutRunProgress;
  cvs: Scout[];
}

const assertRunAccess = async (userId: string, isAdmin: boolean, run: ScoutRun): Promise<void> => {
  await assertCompanyResourceAccess(
    userId,
    isAdmin ? UserRole.Admin : UserRole.Recruiter,
    run.organizationId,
    run.recruiterId
  );
};

const loadRun = async (runId: string): Promise<ScoutRun> => {
  const run = await runRepo().findOne({
    where: { id: runId },
    relations: { scoutJob: { role: true } },
  });
  if (!run) {
    throw new NotFoundError("Scout run not found");
  }
  return run;
};

/** The polling endpoint's payload: the run plus every CV's current state. */
export const fetchRun = async (
  runId: string,
  userId: string,
  isAdmin: boolean
): Promise<ScoutRunDetail> => {
  const run = await loadRun(runId);
  await assertRunAccess(userId, isAdmin, run);

  const cvs = await scoutRepo().find({
    where: { scoutRunId: runId },
    order: { rank: { direction: "ASC", nulls: "LAST" }, position: "ASC" },
  });

  const progress: ScoutRunProgress = {
    queued: cvs.filter((cv) => cv.status === ScoutCvStatus.Queued).length,
    processing: cvs.filter((cv) => cv.status === ScoutCvStatus.Processing).length,
    scored: cvs.filter((cv) => cv.status === ScoutCvStatus.Scored).length,
    failed: cvs.filter((cv) => cv.status === ScoutCvStatus.Failed).length,
  };

  return { run, progress, cvs };
};

export interface ScoutShortlistResult {
  run: ScoutRun;
  shortlist: Scout[];
}

export const fetchShortlist = async (
  runId: string,
  userId: string,
  isAdmin: boolean
): Promise<ScoutShortlistResult> => {
  const run = await loadRun(runId);
  await assertRunAccess(userId, isAdmin, run);

  const shortlist = await scoutRepo().find({
    where: { scoutRunId: runId, shortlisted: true },
    relations: { candidate: true },
    order: { rank: "ASC" },
  });

  return { run, shortlist };
};

export const fetchRunsForJob = async (
  scoutJobId: string,
  userId: string,
  isAdmin: boolean,
  options: { limit?: number | string; offset?: number | string } = {}
): Promise<{ runs: ScoutRun[]; total: number }> => {
  const job = await scoutJobRepo().findOne({ where: { id: scoutJobId } });
  if (!job) {
    throw new NotFoundError("Scout campaign not found");
  }
  await assertCompanyResourceAccess(
    userId,
    isAdmin ? UserRole.Admin : UserRole.Recruiter,
    job.organizationId,
    job.postedById
  );

  const limit = Math.min(Number(options.limit) || 20, 100);
  const offset = Number(options.offset) || 0;

  const [runs, total] = await runRepo().findAndCount({
    where: { scoutJobId },
    order: { createdAt: "DESC" },
    take: limit,
    skip: offset,
  });

  return { runs, total };
};

export const reconcileDueScoutCvs = async (): Promise<{
  scanned: number;
  healed: number;
  failed: number;
}> => {
  const ids = await selectDueIds(DUE_SCOUT_CV_SQL, [MAX_DURABLE_ATTEMPTS, SWEEP_BATCH_SIZE]);
  let healed = 0;
  let failed = 0;
  const runIds = new Set<string>();

  for (const id of ids) {
    const row = await scoutRepo().findOne({
      where: { id },
      select: { id: true, scoutRunId: true },
    });
    if (row?.scoutRunId) runIds.add(row.scoutRunId);

    try {
      await processScoutCv(id);
      healed++;
    } catch {
      failed++;
    }
  }

  // Also close out any run still marked processing whose CVs have all settled — a
  // crash between the last CV finishing and finalizeRun would otherwise leave it
  // stuck on "processing" forever.
  const stuck: Array<{ id: string }> = await AppDataSource.query(
    `SELECT r."id" FROM "scout_runs" r
      WHERE r."status" = 'processing'
        AND NOT EXISTS (
          SELECT 1 FROM "scouts" s
           WHERE s."scout_run_id" = r."id"
             AND s."status" IN ('queued', 'processing')
             AND s."attempts" < $1
        )
      LIMIT $2`,
    [MAX_DURABLE_ATTEMPTS, SWEEP_BATCH_SIZE]
  );
  for (const row of stuck) runIds.add(row.id);

  for (const runId of runIds) {
    await finalizeRun(runId).catch((err: unknown) => {
      logger.error(
        `Finalizing scout run ${runId} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }

  return { scanned: ids.length, healed, failed };
};
