/**
 * Limits shared by the scout entity, validators, services and worker. Kept in one
 * place so the DB CHECK constraint, the request validator and the UI copy can never
 * drift apart.
 */

/** Most CVs a recruiter may upload in a single run. */
export const MAX_BATCH_SIZE = 50;

/** Fewest / most candidates the AI may be asked to shortlist. */
export const MIN_SHORTLIST_SIZE = 2;
export const MAX_SHORTLIST_SIZE = 10;
export const DEFAULT_SHORTLIST_SIZE = 5;

/**
 * Ceiling on the CV text sent to the LLM (~6k tokens). Without it a long PDF
 * overflows the model's context and burns every retry attempt on a request that
 * can never succeed.
 */
export const MAX_CV_CHARS = 24_000;

/** Concurrent CVs scored within one run, so a 50-CV run can't starve other tenants. */
export const RUN_CONCURRENCY = 4;
