import "reflect-metadata";
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { DataSource, DataSourceOptions } from "typeorm";
import { User } from "../../src/entities/User.js";
import { Organization } from "../../src/entities/Organization.js";
import { Role } from "../../src/entities/Role.js";
import { PreScreening } from "../../src/entities/PreScreening.js";
import { Job } from "../../src/entities/Job.js";
import { AIConfig } from "../../src/entities/AIConfig.js";
import { Application } from "../../src/entities/Application.js";
import { Conversation } from "../../src/entities/Conversation.js";
import { Message } from "../../src/entities/Message.js";
import { Notification } from "../../src/entities/Notification.js";
import { Plan } from "../../src/entities/Plan.js";
import { Payment } from "../../src/entities/Payment.js";
import { Subscription } from "../../src/entities/Subscription.js";
import { Question } from "../../src/entities/Question.js";
import { Answer } from "../../src/entities/Answer.js";
import { ScoutJob } from "../../src/entities/ScoutJob.js";
import { Scout } from "../../src/entities/Scout.js";
import { TalentEmbedding } from "../../src/entities/TalentEmbedding.js";
import { ErrorLog } from "../../src/entities/ErrorLog.js";
import { AiRecommendation } from "../../src/entities/AiRecommendation.js";

let container: StartedPostgreSqlContainer;
export let testDataSource: DataSource;

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
  AiRecommendation,
];

export async function startTestDatabase(): Promise<void> {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
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
    synchronize: true,
    logging: false,
  };

  testDataSource = new DataSource(options);
  await testDataSource.initialize();

  // Install pgvector extension
  await testDataSource.query("CREATE EXTENSION IF NOT EXISTS vector;").catch(() => {});

  // Override the AppDataSource singleton used by services
  const { AppDataSource } = await import("../../src/database/dataSource.js");
  Object.assign(AppDataSource, testDataSource);
}

export async function stopTestDatabase(): Promise<void> {
  if (testDataSource?.isInitialized) {
    await testDataSource.destroy();
  }
  if (container) {
    await container.stop();
  }
}

export async function clearAllTables(): Promise<void> {
  if (!testDataSource?.isInitialized) return;
  const tableNames = testDataSource.entityMetadatas.map((e) => `"${e.tableName}"`).join(", ");
  // TRUNCATE ... RESTART IDENTITY CASCADE handles FK dependencies in one shot
  await testDataSource.query(`TRUNCATE TABLE ${tableNames} RESTART IDENTITY CASCADE`).catch(() => {
    // Fallback: clear individually, swallowing FK errors
    for (const entity of testDataSource.entityMetadatas) {
      testDataSource
        .getRepository(entity.name)
        .clear()
        .catch(() => {});
    }
  });
}
