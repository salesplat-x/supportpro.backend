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
import { TalentEmbedding } from "../entities/TalentEmbedding.js";
import { ErrorLog } from "../entities/ErrorLog.js";

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
    TalentEmbedding,
    ErrorLog,
  ],
  migrations: [],
  synchronize: true,
  logging: false,
  ssl:
    env.pg_host && !["localhost", "127.0.0.1", "postgres"].includes(env.pg_host)
      ? { rejectUnauthorized: false }
      : false,
};

export default databaseConfig;
