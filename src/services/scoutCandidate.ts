import { AppDataSource } from "../database/dataSource.js";
import { ScoutCandidate } from "../entities/ScoutCandidate.js";
import { CvEmbeddingStatus } from "../types/enums.js";
import { createEmbedding } from "../utils/integrations/openai.js";
import { preprocessText } from "../utils/text.js";
import {
  MAX_DURABLE_ATTEMPTS,
  STALE_LOCK_INTERVAL,
  SWEEP_BATCH_SIZE,
  claimRowById,
  durableFailureUpdate,
  selectDueIds,
} from "../utils/durableJobs.js";
import logger from "../utils/logger.js";
import { MAX_CV_CHARS } from "../config/scout.js";
import type { ScoutCandidateDetails } from "./scoutAssessment.js";

const candidateRepo = () => AppDataSource.getRepository(ScoutCandidate);

export interface UpsertScoutCandidateInput {
  details: ScoutCandidateDetails;
  cvText: string;
  cvFileUrl: string | null;
  cvFileKey: string | null;
  organizationId: string | null;
}

const normalizeEmail = (email: string | null): string | null =>
  email ? email.trim().toLowerCase() || null : null;

/**
 * Adds (or refreshes) a sourced candidate in the platform-wide pool.
 *
 * Deduped on the normalised email via a unique partial index. An `ON CONFLICT`
 * upsert rather than a read-then-write, so two runs uploading the same person at
 * the same time cannot create two pool rows. A candidate with no email on their CV
 * gets a fresh row — we have nothing reliable to dedupe on, and inventing a key
 * would merge two different people.
 */
export const upsertScoutCandidate = async (
  input: UpsertScoutCandidateInput
): Promise<ScoutCandidate> => {
  const { details } = input;
  const emailNormalized = normalizeEmail(details.email);
  const cvText = input.cvText.slice(0, MAX_CV_CHARS);

  const values = {
    emailNormalized,
    fullName: details.fullName,
    phone: details.phone,
    headline: details.headline,
    locationCity: details.city,
    locationState: details.state,
    locationCountry: details.country,
    skills: details.skills.length > 0 ? details.skills : null,
    yearsExperience: details.yearsExperience,
    cvText,
    cvFileUrl: input.cvFileUrl,
    cvFileKey: input.cvFileKey,
    // A refreshed CV must be re-embedded, so the durable job is reset either way.
    embeddingStatus: CvEmbeddingStatus.Pending,
    embeddingAttempts: 0,
    embeddingNextRetryAt: null,
    embeddingLockedAt: null,
    embeddingLastError: null,
    lastSeenAt: new Date(),
  };

  if (!emailNormalized) {
    const created = await candidateRepo().save(
      candidateRepo().create({ ...values, firstSourcedByOrganizationId: input.organizationId })
    );
    scheduleCandidateEmbedding(created.id);
    return created;
  }

  // COALESCE keeps a previously known value when this CV happens to omit it, so a
  // sparser second CV never erases details we already had.
  const result: Array<{ id: string }> = await AppDataSource.query(
    `INSERT INTO scout_candidates (
        email_normalized, full_name, phone, headline,
        location_city, location_state, location_country,
        skills, years_experience, cv_text, cv_file_url, cv_file_key,
        embedding_status, embedding_attempts, embedding_next_retry_at,
        embedding_locked_at, embedding_last_error,
        first_sourced_by_organization_id, last_seen_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',0,NULL,NULL,NULL,$13,NOW())
     ON CONFLICT (email_normalized) WHERE email_normalized IS NOT NULL
     DO UPDATE SET
        full_name = COALESCE(EXCLUDED.full_name, scout_candidates.full_name),
        phone = COALESCE(EXCLUDED.phone, scout_candidates.phone),
        headline = COALESCE(EXCLUDED.headline, scout_candidates.headline),
        location_city = COALESCE(EXCLUDED.location_city, scout_candidates.location_city),
        location_state = COALESCE(EXCLUDED.location_state, scout_candidates.location_state),
        location_country = COALESCE(EXCLUDED.location_country, scout_candidates.location_country),
        skills = COALESCE(EXCLUDED.skills, scout_candidates.skills),
        years_experience = COALESCE(EXCLUDED.years_experience, scout_candidates.years_experience),
        cv_text = EXCLUDED.cv_text,
        cv_file_url = EXCLUDED.cv_file_url,
        cv_file_key = EXCLUDED.cv_file_key,
        embedding_status = 'pending',
        embedding_attempts = 0,
        embedding_next_retry_at = NULL,
        embedding_locked_at = NULL,
        embedding_last_error = NULL,
        last_seen_at = NOW(),
        "updatedAt" = NOW()
     RETURNING id`,
    [
      emailNormalized,
      values.fullName,
      values.phone,
      values.headline,
      values.locationCity,
      values.locationState,
      values.locationCountry,
      values.skills?.join(",") ?? null,
      values.yearsExperience,
      values.cvText,
      values.cvFileUrl,
      values.cvFileKey,
      input.organizationId,
    ]
  );

  const id = result[0]!.id;
  scheduleCandidateEmbedding(id);
  return (await candidateRepo().findOneOrFail({ where: { id } })) as ScoutCandidate;
};

const inFlightEmbeddings = new Set<Promise<void>>();

/** Await fire-and-forget embedding work before asserting on it, or tearing down the test DB. */
export const drainInFlightCandidateEmbeddings = async (): Promise<void> => {
  for (let attempt = 0; attempt < 100 && inFlightEmbeddings.size > 0; attempt++) {
    await Promise.allSettled([...inFlightEmbeddings]);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

/**
 * Fire-and-forget, like the talent CV path. A crash before it lands is covered by
 * the sweep, which finds any candidate still pending.
 */
const scheduleCandidateEmbedding = (candidateId: string): void => {
  const task = new Promise<void>((resolve) => {
    setImmediate(() => {
      generateCandidateEmbedding(candidateId)
        .catch((err: unknown) => {
          logger.error(
            `Scout candidate embedding failed for ${candidateId}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        })
        .finally(resolve);
    });
  }).finally(() => inFlightEmbeddings.delete(task));
  inFlightEmbeddings.add(task);
};

const CLAIM_CANDIDATE_EMBEDDING_SQL = `
  UPDATE "scout_candidates"
  SET "embedding_locked_at" = NOW(),
      "embedding_status" = 'pending'
  WHERE "id" = $1
    AND "embedding_status" IN ('pending', 'failed')
    AND "embedding_attempts" < ${MAX_DURABLE_ATTEMPTS}
    AND ("embedding_next_retry_at" IS NULL OR "embedding_next_retry_at" <= NOW())
    AND ("embedding_locked_at" IS NULL OR "embedding_locked_at" < NOW() - INTERVAL '${STALE_LOCK_INTERVAL}')
  RETURNING "id"
`;

const DUE_CANDIDATE_EMBEDDING_SQL = `
  SELECT "id" FROM "scout_candidates"
  WHERE "cv_text" IS NOT NULL
    AND "embedding_status" IN ('pending', 'failed')
    AND "embedding_attempts" < $1
    AND ("embedding_next_retry_at" IS NULL OR "embedding_next_retry_at" <= NOW())
    AND ("embedding_locked_at" IS NULL OR "embedding_locked_at" < NOW() - INTERVAL '${STALE_LOCK_INTERVAL}')
  LIMIT $2
`;

const recordEmbeddingFailure = async (
  candidateId: string,
  err: unknown,
  options: { permanent?: boolean } = {}
): Promise<void> => {
  const row = await candidateRepo().findOne({
    where: { id: candidateId },
    select: { id: true, embeddingAttempts: true },
  });
  const patch = options.permanent
    ? {
        attempts: MAX_DURABLE_ATTEMPTS,
        nextRetryAt: null as Date | null,
        lockedAt: null,
        lastError: err instanceof Error ? err.message : String(err),
        exhausted: true,
      }
    : durableFailureUpdate(row?.embeddingAttempts ?? 0, err);

  await candidateRepo().update(candidateId, {
    embeddingStatus: patch.exhausted ? CvEmbeddingStatus.Failed : CvEmbeddingStatus.Pending,
    embeddingAttempts: patch.attempts,
    embeddingNextRetryAt: patch.nextRetryAt,
    embeddingLockedAt: patch.lockedAt,
    embeddingLastError: patch.lastError,
  });
};

export const generateCandidateEmbedding = async (candidateId: string): Promise<void> => {
  const claimed = await claimRowById(CLAIM_CANDIDATE_EMBEDDING_SQL, candidateId);
  if (!claimed) return;

  try {
    const candidate = await candidateRepo()
      .createQueryBuilder("candidate")
      .addSelect("candidate.cvText")
      .where("candidate.id = :candidateId", { candidateId })
      .getOne();

    const text = candidate?.cvText?.trim();
    if (!text) {
      await recordEmbeddingFailure(candidateId, new Error("No CV text is stored"), {
        permanent: true,
      });
      return;
    }

    // One vector per candidate (their CV is already capped at MAX_CV_CHARS), so
    // unlike talents there is no chunk table and no best-chunk selection to do.
    const embeddings = await createEmbedding(preprocessText(text));
    const vector = embeddings[0]?.embedding;
    if (!vector) {
      throw new Error("Embedding provider returned no vector");
    }

    await candidateRepo().update(candidateId, {
      embedding: `[${vector.toString()}]`,
      embeddingStatus: CvEmbeddingStatus.Ready,
      embeddingLockedAt: null,
      embeddingNextRetryAt: null,
      embeddingLastError: null,
    });
  } catch (err) {
    await recordEmbeddingFailure(candidateId, err);
    throw err;
  }
};

export const reconcileDueCandidateEmbeddings = async (): Promise<{
  scanned: number;
  healed: number;
  failed: number;
}> => {
  const ids = await selectDueIds(DUE_CANDIDATE_EMBEDDING_SQL, [
    MAX_DURABLE_ATTEMPTS,
    SWEEP_BATCH_SIZE,
  ]);
  let healed = 0;
  let failed = 0;

  for (const id of ids) {
    try {
      await generateCandidateEmbedding(id);
      healed++;
    } catch {
      failed++;
    }
  }

  return { scanned: ids.length, healed, failed };
};
