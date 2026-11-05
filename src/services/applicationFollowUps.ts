import { In, SelectQueryBuilder } from "typeorm";
import env from "../config/env.js";
import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { ApplicationFollowUpEmail } from "../entities/ApplicationFollowUpEmail.js";
import { ScreeningStage } from "../types/enums.js";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../utils/errors";
import EmailService from "../utils/integrations/email/emailService.js";
import { composeApplicationFollowUpEmail } from "../utils/integrations/openai.js";
import logger from "../utils/logger.js";
import {
  applicationSteps,
  FollowUpStatus,
  followUpStatus,
  isApplicationStuck,
  MAX_BODY_LENGTH,
  MAX_SUBJECT_LENGTH,
  nextStepFor,
  sanitizeDraft,
  STAGE_LABEL,
} from "./applicationFollowUpRules.js";
import { RESEND_WINDOW_MS } from "./followUpShared.js";
import { isUniqueViolation } from "./staffRecord.js";

const applicationRepo = () => AppDataSource.getRepository(Application);
const emailRepo = () => AppDataSource.getRepository(ApplicationFollowUpEmail);

// ---- Stage ordering ---------------------------------------------------------------
// Walks the same linked-list map job.ts/aiConfig.ts's createStages() builds (each stage
// key points at the next one, the final entry points at "completed"), the same way the
// frontend's orderedStageKeys() in jobPipeline.ts does, so both sides agree on order.

const isScreeningStage = (value: string): value is ScreeningStage =>
  (Object.values(ScreeningStage) as string[]).includes(value);

export const orderedStageKeys = (
  stages: Record<string, string> | null | undefined
): ScreeningStage[] => {
  if (!stages) return [];
  const values = new Set(Object.values(stages));
  const entry = Object.keys(stages).find((key) => !values.has(key));
  const ordered: ScreeningStage[] = [];
  const visited = new Set<string>();
  let cursor: string | undefined = entry;
  while (cursor && cursor !== ScreeningStage.Completed && !visited.has(cursor)) {
    visited.add(cursor);
    if (isScreeningStage(cursor)) ordered.push(cursor);
    cursor = stages[cursor];
  }
  return ordered;
};

// ---- SQL mirror of isApplicationStuck() --------------------------------------------
// Keeps list filtering and single-application detail from ever disagreeing.

export const stuckApplicationSql = (a: string): string =>
  `(${a}."status" = 'pending' AND ${a}."currentStage" <> 'completed' AND ${a}."updatedAt" <= NOW() - INTERVAL '1 day')`;

const lastSentSnapshotSql = (a: string) => `(
  SELECT fe."application_updated_at_snapshot" FROM application_follow_up_emails fe
  WHERE fe.application_id = ${a}.id AND fe.status = 'sent'
  ORDER BY fe.created_at DESC LIMIT 1
)`;

export interface ApplicationFollowUpFilters {
  stuckStage?: string;
  followUp?: string;
}

/** Adds the admin Applications list's stuckStage / followUp filters to a query. Always
 * restricts to currently-stuck applications first — this list only ever shows stuck rows. */
export const applyApplicationFollowUpFilters = (
  qb: SelectQueryBuilder<Application>,
  filters: ApplicationFollowUpFilters
): void => {
  const a = `"${qb.alias}"`;
  qb.andWhere(stuckApplicationSql(a));
  if (filters.stuckStage) {
    qb.andWhere(`${a}."currentStage" = :stuckStage`, { stuckStage: filters.stuckStage });
  }
  const snapshot = lastSentSnapshotSql(a);
  if (filters.followUp === "none") {
    qb.andWhere(`${snapshot} IS NULL`);
  } else if (filters.followUp === "emailed") {
    qb.andWhere(`${snapshot} IS NOT NULL AND ${a}."updatedAt" <= ${snapshot}`);
  } else if (filters.followUp === "progressed") {
    qb.andWhere(`${snapshot} IS NOT NULL AND ${a}."updatedAt" > ${snapshot}`);
  }
};

export interface StuckApplicationSummary {
  applicationId: string;
  talent: { id: string; firstName: string; lastName: string; email: string };
  job: { id: string; title: string };
  company: { id: string; name: string } | null;
  stage: ScreeningStage;
  daysStuck: number;
  emailsSent: number;
  lastEmailAt: Date | null;
  followUp: FollowUpStatus;
}

const daysSince = (date: Date) =>
  Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / (24 * 60 * 60 * 1000)));

const summarize = async (applications: Application[]): Promise<StuckApplicationSummary[]> => {
  if (applications.length === 0) return [];
  const byApplication = await loadSentEmailsByApplicationIds(applications.map((a) => a.id));

  return applications.map((application) => {
    const mine = (byApplication.get(application.id) ?? []).filter((e) => e.status === "sent");
    const lastSent = mine[0] ?? null;
    return {
      applicationId: application.id,
      talent: {
        id: application.talent.id,
        firstName: application.talent.firstName,
        lastName: application.talent.lastName,
        email: application.talent.email,
      },
      job: { id: application.job.id, title: application.job.role?.name ?? "Untitled role" },
      company: application.job.organization
        ? { id: application.job.organization.id, name: application.job.organization.name }
        : null,
      stage: application.currentStage,
      daysStuck: daysSince(application.updatedAt),
      emailsSent: mine.length,
      lastEmailAt: lastSent?.createdAt ?? null,
      followUp: followUpStatus(application.updatedAt, lastSent),
    };
  });
};

const loadSentEmailsByApplicationIds = async (
  applicationIds: string[]
): Promise<Map<string, ApplicationFollowUpEmail[]>> => {
  const map = new Map<string, ApplicationFollowUpEmail[]>();
  if (applicationIds.length === 0) return map;
  const rows = await emailRepo().find({
    where: { applicationId: In(applicationIds), status: "sent" },
    order: { createdAt: "DESC" },
  });
  for (const row of rows) {
    const list = map.get(row.applicationId) ?? [];
    list.push(row);
    map.set(row.applicationId, list);
  }
  return map;
};

export interface ListStuckApplicationsParams {
  stuckStage?: string;
  followUp?: string;
  search?: string;
  limit?: number | string;
  offset?: number | string;
  sort?: string;
}

export const listStuckApplications = async (
  params: ListStuckApplicationsParams
): Promise<{ applications: StuckApplicationSummary[]; total: number }> => {
  const limit = Math.min(Number(params.limit) || 50, 200);
  const offset = Number(params.offset) || 0;
  const order = params.sort === "asc" ? "ASC" : "DESC";

  const qb = applicationRepo()
    .createQueryBuilder("application")
    .leftJoinAndSelect("application.talent", "talent")
    .leftJoinAndSelect("application.job", "job")
    .leftJoinAndSelect("job.role", "role")
    .leftJoinAndSelect("job.organization", "organization");

  applyApplicationFollowUpFilters(qb, params);

  if (params.search?.trim()) {
    const term = `%${params.search.trim().toLowerCase()}%`;
    qb.andWhere(
      "(LOWER(talent.firstName) LIKE :term OR LOWER(talent.lastName) LIKE :term OR LOWER(talent.email) LIKE :term)",
      { term }
    );
  }

  const [applications, total] = await qb
    .orderBy("application.updatedAt", order)
    .skip(offset)
    .take(limit)
    .getManyAndCount();

  return { applications: await summarize(applications), total };
};

export const talentStuckApplications = async (
  talentId: string
): Promise<StuckApplicationSummary[]> => {
  const qb = applicationRepo()
    .createQueryBuilder("application")
    .leftJoinAndSelect("application.talent", "talent")
    .leftJoinAndSelect("application.job", "job")
    .leftJoinAndSelect("job.role", "role")
    .leftJoinAndSelect("job.organization", "organization")
    .where("application.talentId = :talentId", { talentId });

  applyApplicationFollowUpFilters(qb, {});
  const applications = await qb.orderBy("application.updatedAt", "ASC").getMany();
  return summarize(applications);
};

// ---- Single application ------------------------------------------------------------

const loadFollowUpApplication = async (applicationId: string): Promise<Application> => {
  const application = await applicationRepo().findOne({
    where: { id: applicationId },
    relations: { talent: true, job: { role: true, organization: true } },
  });
  if (!application) {
    throw new NotFoundError("Application not found");
  }
  return application;
};

export const getApplicationFollowUp = async (applicationId: string) => {
  const application = await loadFollowUpApplication(applicationId);
  const ordered = orderedStageKeys(application.stages);
  const emails = await emailRepo().find({
    where: { applicationId },
    order: { step: "DESC" },
  });
  const lastSent = emails.find((email) => email.status === "sent") ?? null;
  const stuck = isApplicationStuck(application);

  return {
    applicationId: application.id,
    talentName: `${application.talent.firstName} ${application.talent.lastName}`.trim(),
    jobTitle: application.job.role?.name ?? "Untitled role",
    companyName: application.job.organization?.name ?? null,
    stage: application.currentStage,
    stuck,
    daysStuck: daysSince(application.updatedAt),
    steps: applicationSteps(ordered, application.currentStage),
    nextSteps: stuck ? nextStepFor(application.currentStage) : null,
    followUp: followUpStatus(application.updatedAt, lastSent),
    emails,
  };
};

const assertStuck = (application: Application) => {
  if (!isApplicationStuck(application)) {
    throw new ValidationError("This application isn't stuck right now");
  }
};

export const draftApplicationFollowUpEmail = async (
  applicationId: string
): Promise<{ subject: string; body: string }> => {
  const application = await loadFollowUpApplication(applicationId);
  assertStuck(application);
  const next = nextStepFor(application.currentStage);
  const previousSteps = await emailRepo().find({
    where: { applicationId, status: "sent" },
    order: { step: "ASC" },
    take: 20,
  });

  let content: string | null | undefined;
  try {
    const response = await composeApplicationFollowUpEmail({
      talentFirstName: application.talent.firstName,
      jobTitle: application.job.role?.name ?? "the role",
      companyName: application.job.organization?.name ?? undefined,
      stage: STAGE_LABEL[application.currentStage],
      nextSteps: next.steps,
      ctaLabel: next.ctaLabel,
      daysStuck: daysSince(application.updatedAt),
      previousSteps: previousSteps.map((email) => ({
        step: email.step,
        subject: email.subject,
        sentAt: email.createdAt.toISOString(),
      })),
    });
    content = response?.message.content;
  } catch (err) {
    logger.error(`Application follow-up draft failed for ${applicationId}: ${String(err)}`);
    throw new AppError(
      502,
      "AI_UNAVAILABLE",
      "The AI couldn't write an email right now. Please try again."
    );
  }

  try {
    return sanitizeDraft(content);
  } catch (err) {
    throw new ValidationError(`${(err as Error).message}. Please try again.`);
  }
};

export interface SendApplicationFollowUpPayload {
  subject: string;
  body: string;
  confirm?: boolean;
}

export const sendApplicationFollowUpEmail = async (
  adminId: string,
  applicationId: string,
  payload: SendApplicationFollowUpPayload
): Promise<ApplicationFollowUpEmail> => {
  const subject = payload.subject.trim();
  const body = payload.body.trim();
  if (!subject || !body) {
    throw new ValidationError("Add a subject and a message");
  }
  if (subject.length > MAX_SUBJECT_LENGTH || body.length > MAX_BODY_LENGTH) {
    throw new ValidationError("The subject or message is too long");
  }

  const application = await loadFollowUpApplication(applicationId);
  assertStuck(application);
  if (application.talent.followUpEmailsOptedOutAt) {
    throw new ConflictError("This person unsubscribed from follow-up emails");
  }

  const lastSent = await emailRepo().findOne({
    where: { applicationId, status: "sent" },
    order: { createdAt: "DESC" },
  });
  if (
    lastSent &&
    Date.now() - lastSent.createdAt.getTime() < RESEND_WINDOW_MS &&
    !payload.confirm
  ) {
    throw new ConflictError(
      "This talent was emailed less than 24 hours ago about this application. Confirm to send another."
    );
  }

  const next = nextStepFor(application.currentStage);
  const saveRecord = () =>
    AppDataSource.transaction(async (manager) => {
      const existingCount = await manager.count(ApplicationFollowUpEmail, {
        where: { applicationId },
      });
      return manager.save(
        ApplicationFollowUpEmail,
        manager.create(ApplicationFollowUpEmail, {
          applicationId,
          sentById: adminId,
          step: existingCount + 1,
          stage: application.currentStage,
          applicationUpdatedAtSnapshot: application.updatedAt,
          subject,
          body,
          status: "sent",
          error: null,
        })
      );
    });
  // An automatic email can take the same step number at the same moment. One retry settles it.
  const record = await saveRecord().catch((err: unknown) => {
    if (isUniqueViolation(err)) return saveRecord();
    throw err;
  });

  try {
    await new EmailService().sendApplicationFollowUp({
      to: application.talent.email,
      subject,
      jobTitle: application.job.role?.name ?? "the role",
      companyName: application.job.organization?.name ?? undefined,
      paragraphs: body
        .split(/\n\s*\n|\n/)
        .map((line) => line.trim())
        .filter(Boolean),
      ctaLabel: next.ctaLabel,
      ctaUrl: `${env.website || "https://auxhr.com"}/talentDashboard/applicationPipeline/${application.jobId}`,
    });
  } catch (err) {
    record.status = "failed";
    record.error = err instanceof Error ? err.message : String(err);
    await emailRepo().save(record);
    logger.error(`Application follow-up to ${applicationId} failed: ${record.error}`);
    throw new AppError(502, "EMAIL_FAILED", "The email couldn't be sent. It was saved as failed.");
  }

  return emailRepo().save(record);
};
