import logger from "../utils/logger.js";
import { reconcileDueCvEmbeddings } from "./user.js";
import { moveOnScoredCvMatches, reconcileDueMatchVerdicts } from "./applicationStage.js";
import {
  ensureDuePreScreenings,
  reconcileDueNextPreScreeningSets,
  reconcileDuePreScreeningGenerations,
} from "./prescreening.js";
import { reconcileDueScoutCvs } from "./scoutRun.js";
import { reconcileDueCandidateEmbeddings } from "./scoutCandidate.js";
import { reconcileDueDocumentFinalization } from "./contracts.js";
import { clearOldAiClaims } from "./peopleAi.js";
import { runStuckEmailSweep } from "./stuckEmails.js";
import { reconcileDueSupportDrafts } from "./supportAi.js";
import { closeExpiredJobs } from "./job.js";
import { finalizeScheduledEndings } from "./staff.js";
import { reconcileDueInterviewTranscripts } from "./aiInterviewTranscript.js";
import { reconcileDueInterviewScoring } from "./aiInterviewScoring.js";

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
    await reconcileDueSupportDrafts();
  } catch (err) {
    logger.error(`Support draft sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await clearOldAiClaims();
  } catch (err) {
    logger.error(`AI claim cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await finalizeScheduledEndings();
  } catch (err) {
    logger.error(
      `Scheduled employment end sweep failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    await closeExpiredJobs();
  } catch (err) {
    logger.error(`Job closing sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await reconcileDueInterviewTranscripts();
  } catch (err) {
    logger.error(
      `Interview transcript sweep failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    await reconcileDueInterviewScoring();
  } catch (err) {
    logger.error(
      `Interview scoring sweep failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    await moveOnScoredCvMatches();
  } catch (err) {
    logger.error(
      `CV match stage sweep failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    await ensureDuePreScreenings();
  } catch (err) {
    logger.error(
      `First pre-assessment sweep failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  try {
    await reconcileDueNextPreScreeningSets();
  } catch (err) {
    logger.error(
      `Next pre-assessment sweep failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
};
