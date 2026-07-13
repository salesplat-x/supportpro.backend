import "reflect-metadata";
import "dotenv/config";
import { AppDataSource } from "../database/dataSource.js";
import logger from "../utils/logger.js";

async function run(): Promise<void> {
  await AppDataSource.initialize();
  // "each" — not the default "all" — so every migration file commits independently.
  // Some migrations (e.g. adding an enum value) can't be used until their own
  // transaction commits, which "all" would prevent when running from a fresh DB.
  const applied = await AppDataSource.runMigrations({ transaction: "each" });
  logger.info(
    `Migrations applied: ${applied.length ? applied.map((m) => m.name).join(", ") : "none pending"}`
  );
  await AppDataSource.destroy();
}

run().catch((err: Error) => {
  logger.error(`Migration run failed: ${err.message}`);
  process.exit(1);
});
