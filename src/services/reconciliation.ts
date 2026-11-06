import logger from "../utils/logger.js";
import { reconcileDueCvEmbeddings } from "./user.js";
import { reconcileDueMatchVerdicts } from "./applicationStage.js";
import { reconcileDuePreScreeningGenerations } from "./prescreening.js";
import { reconcileDueScoutCvs } from "./scoutRun.js";
import { reconcileDueCandidateEmbeddings } from "./scoutCandidate.js";
import { reconcileDueDocumentFinalization } from "./contracts.js";
import { clearOldAiClaims } from "./peopleAi.js";
import { runStuckEmailSweep } from "./stuckEmails.js";

/**
 * CV embedding generation runs fire-and-forget after a profile update responds
 * (see services/user.ts editProfile). If it fails after retries, or the process
 * restarts mid-flight, the work is otherwise lost silently. This sweep finds
 * talents with stored cvText but missing/stale embeddings and regenerates them.
 */
export const reconcilePendingCvEmbeddings = reconcileDueCvEmbeddings;

export const reconcileDurableJobs = async (): Promise<void> => {
  try {
    await reconcileDueCvEmbeddings();
  } catch (err) {
    logger.error(
      `CV embedding reconciliation sweep failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    await reconcileDueMatchVerdicts();
  } catch (err) {
    logger.error(
      `Match verdict reconciliation sweep failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    await reconcileDuePreScreeningGenerations();
  } catch (err) {
    logger.error(
      `Pre-screening reconciliation sweep failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  // Picks up CVs abandoned by a restart mid-run and closes out runs whose last CV
  // settled without the run being finalized.
  try {
    await reconcileDueScoutCvs();
  } catch (err) {
    logger.error(
      `Scout CV reconciliation sweep failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    await reconcileDueCandidateEmbeddings();
  } catch (err) {
    logger.error(
      `Scout candidate embedding sweep failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    await reconcileDueDocumentFinalization();
  } catch (err) {
    logger.error(
      `Signed document sweep failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    await runStuckEmailSweep();
  } catch (err) {
    logger.error(`Stuck email sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await clearOldAiClaims();
  } catch (err) {
    logger.error(`AI claim cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
