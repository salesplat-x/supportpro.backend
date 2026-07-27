import "reflect-metadata";
import "dotenv/config";
import { IsNull } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { ScreeningStage } from "../types/enums.js";
import { triggerMatchVerdict } from "../services/applicationStage.js";
import logger from "../utils/logger.js";

// One-off fix-up for applications that completed their pipeline before the
// verdict-validation bug was fixed (an unvalidated LLM response could silently
// fail to save, leaving matchVerdict null forever with no retry). Finds every
// completed application still missing a verdict and (re)generates one. Safe to
// run repeatedly — only touches rows where matchVerdict is still null, and the
// existing OpenAI client concurrency limiter throttles the calls, so these can
// all be kicked off together rather than manually batched.
async function run(): Promise<void> {
  await AppDataSource.initialize();
  const applicationRepo = AppDataSource.getRepository(Application);

  const applications = await applicationRepo.find({
    where: { currentStage: ScreeningStage.Completed, matchVerdict: IsNull() },
    relations: { talent: true },
  });

  logger.info(`Verdict backfill: found ${applications.length} completed application(s) with no verdict`);

  await Promise.all(applications.map((application) => triggerMatchVerdict(application.talent, application)));

  const stillMissing = await applicationRepo.count({
    where: { currentStage: ScreeningStage.Completed, matchVerdict: IsNull() },
  });

  logger.info(
    `Verdict backfill: ${applications.length - stillMissing} succeeded, ${stillMissing} still missing (check logs above for individual failures)`
  );
  await AppDataSource.destroy();
}

run().catch((err: Error) => {
  logger.error(`Verdict backfill failed: ${err.message}`);
  process.exit(1);
});
