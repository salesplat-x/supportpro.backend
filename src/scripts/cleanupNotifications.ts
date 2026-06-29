import "reflect-metadata";
import "dotenv/config";
import { AppDataSource } from "../database/dataSource.js";
import { Notification } from "../entities/Notification.js";
import logger from "../utils/logger.js";

async function run(): Promise<void> {
  await AppDataSource.initialize();
  const result = await AppDataSource.getRepository(Notification)
    .createQueryBuilder()
    .delete()
    .where("deleted = true AND created_at < NOW() - INTERVAL '90 days'")
    .execute();
  logger.info(`Cleanup: removed ${result.affected ?? 0} old notifications`);
  await AppDataSource.destroy();
}

run().catch((err: Error) => {
  logger.error(`Notification cleanup failed: ${err.message}`);
  process.exit(1);
});
