import "reflect-metadata";
import "dotenv/config";
import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { rescoreCvSimilarityForTalent } from "../services/applicationStage.js";
import logger from "../utils/logger.js";

// One-off fix-up for applications created before CV match scores were computed
// server-side: the score only existed once the talent's browser reached the
// final CV stage, so most applications have none and some sit at that stage
// forever. Rescores every talent with an open application and puts anything
// parked at the CV stage through the gate. Safe to run repeatedly.
async function run(): Promise<void> {
  await AppDataSource.initialize();

  const rows: Array<{ talentId: string }> = await AppDataSource.getRepository(Application)
    .createQueryBuilder("application")
    .select("DISTINCT application.talentId", "talentId")
    .where("application.currentStage <> 'completed'")
    .getRawMany();

  logger.info(`CV score backfill: rescoring ${rows.length} talent(s)`);

  let failed = 0;
  for (const { talentId } of rows) {
    try {
      await rescoreCvSimilarityForTalent(talentId);
    } catch (err) {
      failed++;
      logger.error(`CV score backfill failed for talent ${talentId}: ${(err as Error).message}`);
    }
  }

  logger.info(`CV score backfill: ${rows.length - failed} succeeded, ${failed} failed`);
  await AppDataSource.destroy();
}

run().catch((err: Error) => {
  logger.error(`CV score backfill failed: ${err.message}`);
  process.exit(1);
});
