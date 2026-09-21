import "reflect-metadata";
import "dotenv/config";
import { AppDataSource } from "../database/dataSource.js";
import { syncPlansFromCatalog } from "../services/planSync.js";
import logger from "../utils/logger.js";

async function run(): Promise<void> {
  await AppDataSource.initialize();

  const plans = await syncPlansFromCatalog();
  for (const [key, plan] of plans) {
    logger.info(`Plan synced: ${key} -> id=${plan.id} paystackPlanCode=${plan.paystackPlanCode}`);
  }

  await AppDataSource.destroy();
}

run().catch((err) => {
  logger.error(`syncPlans failed: ${(err as Error).message}`);
  process.exit(1);
});
