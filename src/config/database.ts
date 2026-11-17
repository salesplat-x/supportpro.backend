import path from "path";
import { DataSourceOptions } from "typeorm";
import env from "./env.js";
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
import { ScoutRun } from "../entities/ScoutRun.js";
import { ScoutCandidate } from "../entities/ScoutCandidate.js";
import { TalentEmbedding } from "../entities/TalentEmbedding.js";
import { ErrorLog } from "../entities/ErrorLog.js";
import { AiRecommendation } from "../entities/AiRecommendation.js";
import { Feedback } from "../entities/Feedback.js";
import { PaymentWebhookEvent } from "../entities/PaymentWebhookEvent.js";
import { OrganizationMember } from "../entities/OrganizationMember.js";
import { OrganizationJoinRequest } from "../entities/OrganizationJoinRequest.js";
import { OrganizationInvite } from "../entities/OrganizationInvite.js";
import { FeatureUsageCounter } from "../entities/FeatureUsageCounter.js";
import { OrganizationPlanHistory } from "../entities/OrganizationPlanHistory.js";
import { OnboardingEmail } from "../entities/OnboardingEmail.js";
import { ApplicationFollowUpEmail } from "../entities/ApplicationFollowUpEmail.js";
import { StaffMember } from "../entities/StaffMember.js";
import { StaffActivity } from "../entities/StaffActivity.js";
import { StaffAccessLog } from "../entities/StaffAccessLog.js";
import { Benefit } from "../entities/Benefit.js";
import { PayPackage } from "../entities/PayPackage.js";
import { ShareGrant } from "../entities/ShareGrant.js";
import { CommissionPlan } from "../entities/CommissionPlan.js";
import { StaffDocument } from "../entities/StaffDocument.js";
import { StaffChecklistTask } from "../entities/StaffChecklistTask.js";
import { PeopleAiClaim } from "../entities/PeopleAiClaim.js";
import { StaffJobDescription } from "../entities/StaffJobDescription.js";
import { StaffGoal } from "../entities/StaffGoal.js";
import { StaffGoalProgressEvent } from "../entities/StaffGoalProgressEvent.js";
import { StaffWeeklyReport } from "../entities/StaffWeeklyReport.js";
import { StaffDevelopmentItem } from "../entities/StaffDevelopmentItem.js";
import { StaffMonthlyFeedback } from "../entities/StaffMonthlyFeedback.js";
import { StaffEfficiencyTip } from "../entities/StaffEfficiencyTip.js";
import { CompanyQuarterGoal } from "../entities/CompanyQuarterGoal.js";
import { AiFeatureSetting } from "../entities/AiFeatureSetting.js";
import { StaffHrAssignment } from "../entities/StaffHrAssignment.js";
import { StaffCompletionRequest } from "../entities/StaffCompletionRequest.js";
import { OrganizationOwnershipTransfer } from "../entities/OrganizationOwnershipTransfer.js";
import { StuckEmailTimer } from "../entities/StuckEmailTimer.js";
import { ApplicationReference } from "../entities/ApplicationReference.js";
import { AiInterview } from "../entities/AiInterview.js";
import { AiInterviewQuestion } from "../entities/AiInterviewQuestion.js";
import { SavedJob } from "../entities/SavedJob.js";

const databaseConfig: DataSourceOptions = {
  type: "postgres",
  host: env.pg_host,
  port: Number(env.pg_port) || 5432,
  username: env.pg_user,
  password: env.pg_password,
  database: env.pg_db,
  entities: [
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
  ],
  migrations: [path.join(__dirname, "../migrations/*.{js,ts}")],
  synchronize: false,
  logging: false,
  ssl:
    env.pg_host && !["localhost", "127.0.0.1", "postgres", "pgbouncer"].includes(env.pg_host)
      ? { rejectUnauthorized: false }
      : false,
  extra: {
    max: 20,
    min: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  },
};

export default databaseConfig;
