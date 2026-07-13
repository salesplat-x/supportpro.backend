import "reflect-metadata";
import "dotenv/config";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { DataSource, DataSourceOptions } from "typeorm";
import path from "path";
import logger from "../utils/logger.js";
import { User } from "../entities/User.js";
import { Organization } from "../entities/Organization.js";
import { Role } from "../entities/Role.js";
import { PreScreening } from "../entities/PreScreening.js";
import { Job } from "../entities/Job.js";
import { AIConfig } from "../entities/AIConfig.js";
import { Application } from "../entities/Application.js";
import { Conversation } from "../entities/Conversation.js";
import { Message } from "../entities/Message.js";
import { Notification } from "../entities/Notification.js";
import { Plan } from "../entities/Plan.js";
import { Payment } from "../entities/Payment.js";
import { Subscription } from "../entities/Subscription.js";
import { Question } from "../entities/Question.js";
import { Answer } from "../entities/Answer.js";
import { ScoutJob } from "../entities/ScoutJob.js";
import { Scout } from "../entities/Scout.js";
import { TalentEmbedding } from "../entities/TalentEmbedding.js";
import { ErrorLog } from "../entities/ErrorLog.js";

const ALL_ENTITIES = [
  User,
  Organization,
  Role,
  PreScreening,
  Job,
  AIConfig,
  Application,
  Conversation,
  Message,
  Notification,
  Plan,
  Payment,
  Subscription,
  Question,
  Answer,
  ScoutJob,
  Scout,
  TalentEmbedding,
  ErrorLog,
];

async function run(): Promise<void> {
  const container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
    .withStartupTimeout(120_000)
    .start();

  const options: DataSourceOptions = {
    type: "postgres",
    host: container.getHost(),
    port: container.getPort(),
    username: container.getUsername(),
    password: container.getPassword(),
    database: container.getDatabase(),
    entities: ALL_ENTITIES,
    migrations: [path.join(__dirname, "../migrations/*.{js,ts}")],
    synchronize: false,
    logging: false,
  };

  const dataSource = new DataSource(options);
  await dataSource.initialize();

  try {
    // "each" — matches src/scripts/migrate.ts — some migrations (e.g. adding an
    // enum value) can't be used until their own transaction commits, which the
    // default "all" mode would prevent when running every migration from scratch.
    await dataSource.runMigrations({ transaction: "each" });

    const sqlInMemory = await dataSource.driver.createSchemaBuilder().log();
    const pending = [...sqlInMemory.upQueries];

    if (pending.length > 0) {
      logger.error(
        `Migration drift detected — entities do not match the committed migrations. Run "npm run migration:generate" and commit the result. Pending queries:\n${pending
          .map((q) => q.query)
          .join("\n")}`
      );
      process.exitCode = 1;
      return;
    }

    logger.info("No migration drift detected.");
  } finally {
    await dataSource.destroy();
    await container.stop();
  }
}

run().catch((err: Error) => {
  logger.error(`Migration drift check failed: ${err.message}`);
  process.exit(1);
});
