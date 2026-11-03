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
import { ScoutRun } from "../../src/entities/ScoutRun.js";
import { ScoutCandidate } from "../../src/entities/ScoutCandidate.js";
import { TalentEmbedding } from "../../src/entities/TalentEmbedding.js";
import { ErrorLog } from "../../src/entities/ErrorLog.js";
import { AiRecommendation } from "../../src/entities/AiRecommendation.js";
import { PaymentWebhookEvent } from "../../src/entities/PaymentWebhookEvent.js";
import { Feedback } from "../../src/entities/Feedback.js";
import { OrganizationMember } from "../../src/entities/OrganizationMember.js";
import { OrganizationJoinRequest } from "../../src/entities/OrganizationJoinRequest.js";
import { OrganizationInvite } from "../../src/entities/OrganizationInvite.js";
import { FeatureUsageCounter } from "../../src/entities/FeatureUsageCounter.js";
import { OrganizationPlanHistory } from "../../src/entities/OrganizationPlanHistory.js";
import { OnboardingEmail } from "../../src/entities/OnboardingEmail.js";
import { ApplicationFollowUpEmail } from "../../src/entities/ApplicationFollowUpEmail.js";
import { StaffMember } from "../../src/entities/StaffMember.js";
import { StaffActivity } from "../../src/entities/StaffActivity.js";
import { StaffAccessLog } from "../../src/entities/StaffAccessLog.js";
import { Benefit } from "../../src/entities/Benefit.js";
import { PayPackage } from "../../src/entities/PayPackage.js";
import { ShareGrant } from "../../src/entities/ShareGrant.js";
import { CommissionPlan } from "../../src/entities/CommissionPlan.js";
import { StaffDocument } from "../../src/entities/StaffDocument.js";
import { StaffChecklistTask } from "../../src/entities/StaffChecklistTask.js";
import { PeopleAiClaim } from "../../src/entities/PeopleAiClaim.js";
import { StaffJobDescription } from "../../src/entities/StaffJobDescription.js";
import { StaffGoal } from "../../src/entities/StaffGoal.js";
import { StaffGoalProgressEvent } from "../../src/entities/StaffGoalProgressEvent.js";
import { StaffWeeklyReport } from "../../src/entities/StaffWeeklyReport.js";
import { StaffDevelopmentItem } from "../../src/entities/StaffDevelopmentItem.js";
import { StaffMonthlyFeedback } from "../../src/entities/StaffMonthlyFeedback.js";

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
  ScoutRun,
  ScoutCandidate,
  TalentEmbedding,
  ErrorLog,
  AiRecommendation,
  Feedback,
  PaymentWebhookEvent,
  OrganizationMember,
  OrganizationJoinRequest,
  OrganizationInvite,
  FeatureUsageCounter,
  OrganizationPlanHistory,
  OnboardingEmail,
  ApplicationFollowUpEmail,
  StaffMember,
  StaffActivity,
  StaffAccessLog,
  Benefit,
  PayPackage,
  ShareGrant,
  CommissionPlan,
  StaffDocument,
  StaffChecklistTask,
  PeopleAiClaim,
  StaffJobDescription,
  StaffGoal,
  StaffGoalProgressEvent,
  StaffWeeklyReport,
  StaffDevelopmentItem,
  StaffMonthlyFeedback,
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

/**
 * Fire-and-forget work that can outlive the test that started it — it holds row
 * locks that make TRUNCATE fail, and it mutates rows a later test then asserts on.
 */
async function drainBackgroundWork(): Promise<void> {
  const [
    { drainInFlightMatchVerdicts },
    { drainInFlightScoutRuns },
    { drainInFlightCandidateEmbeddings },
  ] = await Promise.all([
    import("../../src/services/applicationStage.js"),
    import("../../src/services/scoutRun.js"),
    import("../../src/services/scoutCandidate.js"),
  ]);
  await drainInFlightScoutRuns();
  await drainInFlightCandidateEmbeddings();
  await drainInFlightMatchVerdicts();
}

export async function stopTestDatabase(): Promise<void> {
  await drainBackgroundWork();
  if (testDataSource?.isInitialized) {
    await testDataSource.destroy();
  }
  if (container) {
    await container.stop();
  }
}

export async function clearAllTables(): Promise<void> {
  if (!testDataSource?.isInitialized) return;
  await drainBackgroundWork();
  const tableNames = testDataSource.entityMetadatas.map((e) => `"${e.tableName}"`).join(", ");
  // TRUNCATE ... RESTART IDENTITY CASCADE handles FK dependencies in one shot, but it needs
  // ACCESS EXCLUSIVE on every table — so background work that outlives a test (pre-screening
  // generation, notification fan-out) can hold a row lock and make it fail. Swallowing that
  // used to leave a partially-populated database, which surfaced as inexplicable 401s/404s
  // in whichever test ran next, so retry instead and fail loudly if it never succeeds.
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await testDataSource.query(`TRUNCATE TABLE ${tableNames} RESTART IDENTITY CASCADE`);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw new Error(
    `clearAllTables: could not truncate after 5 attempts — tests would run against a dirty database. Last error: ${String(lastError)}`
  );
}
