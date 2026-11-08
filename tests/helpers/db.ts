import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  STAMP_STAGE_REACHED_FUNCTION,
  STAMP_STAGE_REACHED_TRIGGER,
} from "../../src/migrations/1789004400000-AddAssessmentScreeningStages.js";
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
import { StaffEfficiencyTip } from "../../src/entities/StaffEfficiencyTip.js";
import { CompanyQuarterGoal } from "../../src/entities/CompanyQuarterGoal.js";
import { AiFeatureSetting } from "../../src/entities/AiFeatureSetting.js";
import { StaffHrAssignment } from "../../src/entities/StaffHrAssignment.js";
import { StaffCompletionRequest } from "../../src/entities/StaffCompletionRequest.js";
import { OrganizationOwnershipTransfer } from "../../src/entities/OrganizationOwnershipTransfer.js";
import { StuckEmailTimer } from "../../src/entities/StuckEmailTimer.js";
import { ApplicationReference } from "../../src/entities/ApplicationReference.js";
import { SavedJob } from "../../src/entities/SavedJob.js";
import { AiInterview } from "../../src/entities/AiInterview.js";
import { AiInterviewQuestion } from "../../src/entities/AiInterviewQuestion.js";
import { ApplicationConsent } from "../../src/entities/ApplicationConsent.js";
import { ApplicationCheck } from "../../src/entities/ApplicationCheck.js";

export let testDataSource: DataSource;
let databaseName: string | undefined;

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
  StaffEfficiencyTip,
  CompanyQuarterGoal,
  AiFeatureSetting,
  StaffHrAssignment,
  StaffCompletionRequest,
  OrganizationOwnershipTransfer,
  StuckEmailTimer,
  ApplicationReference,
  AiInterview,
  AiInterviewQuestion,
  SavedJob,
  ApplicationConsent,
  ApplicationCheck,
];

const TEMPLATE_DATABASE = "test_template";
const TEMPLATE_LOCK = 4_200_042;

function connectionOptions() {
  return {
    host: process.env.TEST_PG_HOST,
    port: Number(process.env.TEST_PG_PORT),
    user: process.env.TEST_PG_USER,
    password: process.env.TEST_PG_PASSWORD,
  };
}

async function withAdminClient<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ ...connectionOptions(), database: "postgres" });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

function dataSourceFor(database: string, synchronize: boolean): DataSource {
  const { host, port, user, password } = connectionOptions();
  return new DataSource({
    type: "postgres",
    host,
    port,
    username: user,
    password,
    database,
    entities: ALL_ENTITIES,
    synchronize,
    logging: false,
  } satisfies DataSourceOptions);
}

async function buildTemplate(): Promise<void> {
  const template = dataSourceFor(TEMPLATE_DATABASE, false);
  await template.initialize();
  try {
    await template.query("CREATE EXTENSION IF NOT EXISTS vector");
    await template.synchronize();
    await template.query(STAMP_STAGE_REACHED_FUNCTION);
    await template.query(STAMP_STAGE_REACHED_TRIGGER);
  } finally {
    await template.destroy();
  }
}

async function cloneTemplate(name: string): Promise<void> {
  await withAdminClient(async (client) => {
    await client.query("SELECT pg_advisory_lock($1)", [TEMPLATE_LOCK]);
    try {
      const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
        TEMPLATE_DATABASE,
      ]);
      if (!rowCount) {
        await client.query(`CREATE DATABASE "${TEMPLATE_DATABASE}"`);
        try {
          await buildTemplate();
        } catch (error) {
          await client.query(`DROP DATABASE "${TEMPLATE_DATABASE}" WITH (FORCE)`);
          throw error;
        }
      }
      await client.query(
        `CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DATABASE}" STRATEGY FILE_COPY`
      );
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [TEMPLATE_LOCK]);
    }
  });
}

export async function startTestDatabase(): Promise<void> {
  databaseName = `test_${randomUUID().replace(/-/g, "")}`;
  await cloneTemplate(databaseName);

  testDataSource = dataSourceFor(databaseName, false);
  await testDataSource.initialize();

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
    { drainInFlightAiInterviews },
  ] = await Promise.all([
    import("../../src/services/applicationStage.js"),
    import("../../src/services/scoutRun.js"),
    import("../../src/services/scoutCandidate.js"),
    import("../../src/services/aiInterview.js"),
  ]);
  await drainInFlightScoutRuns();
  await drainInFlightCandidateEmbeddings();
  await drainInFlightMatchVerdicts();
  await drainInFlightAiInterviews();
}

export async function stopTestDatabase(): Promise<void> {
  await drainBackgroundWork();
  if (testDataSource?.isInitialized) {
    await testDataSource.destroy();
  }
  if (databaseName) {
    const name = databaseName;
    databaseName = undefined;
    await withAdminClient((client) => client.query(`DROP DATABASE "${name}" WITH (FORCE)`));
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
