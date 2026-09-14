import "reflect-metadata";
import "dotenv/config";
import env from "../config/env.js";
import { AppDataSource } from "../database/dataSource.js";
import { assertNotProduction, parseSeedArgs } from "../seed/guard.js";
import { runSeed } from "../seed/run.js";
import logger from "../utils/logger.js";

async function main(): Promise<void> {
  assertNotProduction(env.app_env);
  const options = parseSeedArgs(process.argv);

  await AppDataSource.initialize();
  try {
    await runSeed(AppDataSource, options);
  } finally {
    if (AppDataSource.isInitialized) {
      await AppDataSource.destroy();
    }
  }
}

main().catch((err: Error) => {
  logger.error(`Seed failed: ${err.message}`);
  process.exit(1);
});
