import axios from "axios";
import { AppDataSource } from "../database/dataSource.js";
import logger from "../utils/logger.js";
import { extractText, overlapChunkText, preprocessText } from "../utils/text.js";
import { createEmbedding } from "../utils/integrations/openai.js";
import { saveTalentEmbedding } from "./user.js";

const EXT_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

interface StuckCvRow {
  id: string;
  cvUrl: string;
}

/**
 * CV embedding generation runs fire-and-forget after a profile update responds
 * (see services/user.ts editProfile). If it fails after retries, or the process
 * restarts mid-flight, the work is otherwise lost silently — the user keeps a
 * cvUrl with no matching talent_embeddings rows, forever. This sweep finds that
 * drift and regenerates the missing embeddings by re-downloading the CV already
 * stored in Cloudinary. Safe to call repeatedly: it only touches users whose CV
 * predates their newest embedding, or has no embedding at all, and is skipped
 * during the upload's own grace window so it never races the original attempt.
 */
export const reconcilePendingCvEmbeddings = async (): Promise<{
  scanned: number;
  healed: number;
  failed: number;
}> => {
  const rows: StuckCvRow[] = await AppDataSource.query(`
    SELECT u."id" AS "id", u."cvUrl" AS "cvUrl"
    FROM "users" u
    LEFT JOIN (
      SELECT user_id, MAX(generated_at) AS generated_at
      FROM talent_embeddings
      GROUP BY user_id
    ) te ON te.user_id = u."id"
    WHERE u."cvUrl" IS NOT NULL
      AND u."cvUploadedAt" IS NOT NULL
      AND (te.generated_at IS NULL OR te.generated_at < u."cvUploadedAt")
      AND u."cvUploadedAt" < NOW() - INTERVAL '10 minutes'
  `);

  let healed = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const ext = row.cvUrl.split(".").pop()?.toLowerCase() ?? "";
      const mimetype = EXT_TO_MIME[ext];
      if (!mimetype) {
        logger.warn(`Reconciliation: unrecognized CV extension for user ${row.id}, skipping`);
        continue;
      }

      const response = await axios.get<ArrayBuffer>(row.cvUrl, {
        responseType: "arraybuffer",
      });
      const buffer = Buffer.from(response.data);
      const text = await extractText(buffer, mimetype);
      if (!text) {
        logger.warn(`Reconciliation: could not extract CV text for user ${row.id}, skipping`);
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
