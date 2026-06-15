import "dotenv/config";
import logger from "./config/logger";
import env from "./config/env";
import { newMongoDBConnection } from "./config/db";
import { setupPostgresDB } from "./repository/v1/pg";
import createApp from "./createApp";

const PORT = env.port;

export default async function startApplication(): Promise<void> {
  const app = createApp();

  // connect to mongodb via mongoose
  await newMongoDBConnection();

  // setup PostgresDB
  await setupPostgresDB();

  app.listen(PORT, async () => {
    logger.log(`All connections established successfully 🚀`);
    logger.log(`App is listening on http://localhost:${PORT}`);
  });
}
