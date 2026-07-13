import "reflect-metadata";
import "dotenv/config";
import { AppDataSource } from "../database/dataSource.js";
import logger from "../utils/logger.js";

async function run(): Promise<void> {
  await AppDataSource.initialize();
  const applied = await AppDataSource.runMigrations();
  logger.info(
    `Migrations applied: ${applied.length ? applied.map((m) => m.name).join(", ") : "none pending"}`
  );
  await AppDataSource.destroy();
}

run().catch((err: Error) => {
  logger.error(`Migration run failed: ${err.message}`);
  process.exit(1);
});
