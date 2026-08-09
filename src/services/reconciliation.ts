import { AppDataSource } from "../database/dataSource.js";
import logger from "../utils/logger.js";
import { overlapChunkText, preprocessText } from "../utils/text.js";
import { createEmbedding } from "../utils/integrations/openai.js";
import { saveTalentEmbedding } from "./user.js";

interface StuckCvRow {
  id: string;
  cvText: string;
}

/**
 * CV embedding generation runs fire-and-forget after a profile update responds
 * (see services/user.ts editProfile). If it fails after retries, or the process
 * restarts mid-flight, the work is otherwise lost silently. This sweep finds
 * talents with stored cvText but missing/stale embeddings and regenerates them.
 */
export const reconcilePendingCvEmbeddings = async (): Promise<{
  scanned: number;
  healed: number;
  failed: number;
}> => {
  const rows: StuckCvRow[] = await AppDataSource.query(`
    SELECT u."id" AS "id", u."cvText" AS "cvText"
    FROM "users" u
    LEFT JOIN (
      SELECT user_id, MAX(generated_at) AS generated_at
      FROM talent_embeddings
      GROUP BY user_id
    ) te ON te.user_id = u."id"
    WHERE u."cvText" IS NOT NULL
      AND u."cvUploadedAt" IS NOT NULL
      AND (te.generated_at IS NULL OR te.generated_at < u."cvUploadedAt")
      AND u."cvUploadedAt" < NOW() - INTERVAL '10 minutes'
  `);

  let healed = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const text = row.cvText?.trim();
      if (!text) {
        logger.warn(`Reconciliation: empty CV text for user ${row.id}, skipping`);
        continue;
      }

      const chunks = overlapChunkText(preprocessText(text));
      const embeddings = await createEmbedding(chunks);
      await saveTalentEmbedding(row.id, chunks, embeddings);
      healed++;
      logger.info(`Reconciliation: healed missing CV embedding for user ${row.id}`);
    } catch (err) {
      failed++;
      logger.error(
        `Reconciliation: failed to heal CV embedding for user ${row.id}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  if (rows.length > 0) {
    logger.info(
      `CV embedding reconciliation sweep: scanned ${rows.length}, healed ${healed}, failed ${failed}`
    );
  }

  return { scanned: rows.length, healed, failed };
};
