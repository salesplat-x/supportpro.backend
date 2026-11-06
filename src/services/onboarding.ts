import { In, SelectQueryBuilder } from "typeorm";
import env from "../config/env.js";
import { AppDataSource } from "../database/dataSource.js";
import { OnboardingEmail } from "../entities/OnboardingEmail.js";
import { User } from "../entities/User.js";
import { DEFAULT_BILLING_PLAN_KEY, UserRole } from "../types/enums.js";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../utils/errors";
import EmailService from "../utils/integrations/email/emailService.js";
import { composeOnboardingEmail } from "../utils/integrations/openai.js";
import logger from "../utils/logger.js";
import { RESEND_WINDOW_MS } from "./followUpShared.js";
import {
  followUpStatus,
  FollowUpStatus,
  MAX_BODY_LENGTH,
  MAX_SUBJECT_LENGTH,
  nextStepsFor,
  OnboardingRole,
  OnboardingStage,
  OnboardingStep,
  RecruiterFacts,
  recruiterStageFrom,
  recruiterSteps,
  sanitizeDraft,
  TalentFacts,
  talentStageFrom,
  talentSteps,
} from "./onboardingRules.js";
import { getProfileCompletion } from "./user.js";

const userRepo = () => AppDataSource.getRepository(User);
const emailRepo = () => AppDataSource.getRepository(OnboardingEmail);

// ---- SQL mirrors of onboardingRules.ts -------------------------------------------------
// Each fact is one boolean SQL expression over a users alias. The stage CASE is built from
// the same facts in the same order as talentStageFrom / recruiterStageFrom, and the single
// user view reads these exact facts back, so list filters and detail views always agree.

const notBlank = (column: string) => `NULLIF(${column}, '') IS NOT NULL`;

const talentFactSql = (u: string): Record<keyof TalentFacts, string> => ({
  emailVerified: `${u}."emailVerifiedAt" IS NOT NULL`,
  hasCv: `(${u}."cvUploadedAt" IS NOT NULL OR ${notBlank(`${u}."cvFileName"`)} OR ${notBlank(
    `${u}."cvText"`
  )})`,
  hasRoles: `EXISTS (SELECT 1 FROM user_roles ob_ur WHERE ob_ur.user_id = ${u}.id)`,
  hasScore: `${u}."prescreeningScore" IS NOT NULL`,
  hasApplication: `EXISTS (SELECT 1 FROM applications ob_a WHERE ob_a.talent_id = ${u}.id)`,
});

const paidJobIdSql = `ob_p."initialConfig" -> 'metadata' ->> 'jobId'`;

const recruiterFactSql = (u: string): Record<keyof RecruiterFacts, string> => ({
  emailVerified: `${u}."emailVerifiedAt" IS NOT NULL`,
  hasCompany: `${u}.active_organization_id IS NOT NULL`,
  onPaidPlan: `EXISTS (
    SELECT 1 FROM organizations ob_o
    WHERE ob_o.id = ${u}.active_organization_id
      AND ob_o.billing_plan <> :onboardingFreePlan
      AND ob_o.billing_status = 'active'
      AND (ob_o.billing_period_end IS NULL OR ob_o.billing_period_end > NOW())
  )`,
  hasPaidJob: `EXISTS (
    SELECT 1 FROM payments ob_p
    WHERE ob_p.status = 'completed'
      AND ${paidJobIdSql} IS NOT NULL
      AND (
        ob_p.user_id = ${u}.id
        OR EXISTS (
          SELECT 1 FROM jobs ob_pj
          WHERE ob_pj.id::text = ${paidJobIdSql} AND ob_pj.posted_by_id = ${u}.id
        )
      )
  )`,
  hasJob: `EXISTS (SELECT 1 FROM jobs ob_j WHERE ob_j.posted_by_id = ${u}.id)`,
  hasScreenedJob: `EXISTS (
    SELECT 1 FROM jobs ob_sj WHERE ob_sj.posted_by_id = ${u}.id AND ob_sj.ai_config_id IS NOT NULL
  )`,
});

export const ONBOARDING_SQL_PARAMS = { onboardingFreePlan: DEFAULT_BILLING_PLAN_KEY };

export const talentStageSql = (u: string): string => {
  const f = talentFactSql(u);
  return `(CASE
    WHEN NOT (${f.emailVerified}) THEN 'verify_email'
    WHEN NOT (${f.hasCv} AND ${f.hasRoles}) THEN 'complete_profile'
    WHEN NOT (${f.hasScore}) THEN 'take_assessment'
    WHEN NOT (${f.hasApplication}) THEN 'apply_to_job'
    ELSE 'active' END)`;
};

export const recruiterStageSql = (u: string): string => {
  const f = recruiterFactSql(u);
  return `(CASE
    WHEN NOT (${f.emailVerified}) THEN 'verify_email'
    WHEN NOT (${f.hasCompany}) THEN 'create_company'
    WHEN (${f.onPaidPlan}) OR (${f.hasPaidJob}) THEN 'active'
    WHEN NOT (${f.hasJob}) THEN 'post_job'
    WHEN NOT (${f.hasScreenedJob}) THEN 'set_up_screening'
    ELSE 'publish_job' END)`;
};

const stageSqlFor = (role: OnboardingRole, u: string) =>
  role === UserRole.Talent ? talentStageSql(u) : recruiterStageSql(u);

const lastSentStageSql = (u: string) => `(
  SELECT ob_e.stage FROM onboarding_emails ob_e
  WHERE ob_e.user_id = ${u}.id AND ob_e.status = 'sent'
  ORDER BY ob_e.created_at DESC LIMIT 1
)`;

/** Adds the admin list's onboardingStage / followUp filters to a users query. */
export const applyOnboardingFilters = (
  qb: SelectQueryBuilder<User>,
  role: OnboardingRole,
  filters: { onboardingStage?: string; followUp?: string }
): void => {
  // Quoted: the admin lists alias users as "user", a reserved word in Postgres.
  const u = `"${qb.alias}"`;
  const stage = stageSqlFor(role, u);
  if (filters.onboardingStage) {
    qb.andWhere(`${stage} = :onboardingStage`, { onboardingStage: filters.onboardingStage });
  }
  if (filters.followUp === "none") {
    qb.andWhere(`${lastSentStageSql(u)} IS NULL`);
  } else if (filters.followUp === "emailed") {
    qb.andWhere(`${lastSentStageSql(u)} = ${stage}`);
  } else if (filters.followUp === "progressed") {
    qb.andWhere(`${lastSentStageSql(u)} <> ${stage}`);
  }
  if (filters.onboardingStage || filters.followUp) {
    qb.setParameters(ONBOARDING_SQL_PARAMS);
  }
};

// ---- Reading facts --------------------------------------------------------------------

const toBool = (value: unknown) => value === true || value === "t" || value === "true";

const loadFacts = async (
  role: OnboardingRole,
  userIds: string[]
): Promise<Map<string, TalentFacts | RecruiterFacts>> => {
  const facts = new Map<string, TalentFacts | RecruiterFacts>();
  if (userIds.length === 0) return facts;
  const sql = role === UserRole.Talent ? talentFactSql("u") : recruiterFactSql("u");
  const qb = userRepo()
    .createQueryBuilder("u")
    .select("u.id", "id")
    .where("u.id IN (:...onboardingUserIds)", { onboardingUserIds: userIds })
    .setParameters(ONBOARDING_SQL_PARAMS);
  for (const [key, expression] of Object.entries(sql)) {
    qb.addSelect(`(${expression})`, key);
  }
  const rows: Array<Record<string, unknown>> = await qb.getRawMany();
  for (const row of rows) {
    const entry = Object.fromEntries(
      Object.keys(sql).map((key) => [key, toBool(row[key])])
    ) as unknown as TalentFacts | RecruiterFacts;
    facts.set(String(row.id), entry);
  }
  return facts;
};

const stageFrom = (role: OnboardingRole, facts: TalentFacts | RecruiterFacts): OnboardingStage =>
  role === UserRole.Talent
    ? talentStageFrom(facts as TalentFacts)
    : recruiterStageFrom(facts as RecruiterFacts);

const stepsFrom = (role: OnboardingRole, facts: TalentFacts | RecruiterFacts): OnboardingStep[] =>
  role === UserRole.Talent
    ? talentSteps(facts as TalentFacts)
    : recruiterSteps(facts as RecruiterFacts);

export interface OnboardingSummary {
  stage: OnboardingStage;
  emailsSent: number;
  lastEmailAt: Date | null;
  followUp: FollowUpStatus;
}

/** Stage and follow-up summary for a page of users of one role, keyed by user id. */
export const onboardingSummaries = async (
  role: OnboardingRole,
  userIds: string[]
): Promise<Map<string, OnboardingSummary>> => {
  const summaries = new Map<string, OnboardingSummary>();
  if (userIds.length === 0) return summaries;

  const [facts, sentEmails] = await Promise.all([
    loadFacts(role, userIds),
    emailRepo().find({
      where: { userId: In(userIds), status: "sent" },
      order: { createdAt: "DESC" },
      select: { userId: true, stage: true, createdAt: true },
    }),
  ]);

  for (const userId of userIds) {
    const userFacts = facts.get(userId);
    if (!userFacts) continue;
    const mine = sentEmails.filter((email) => email.userId === userId);
    const stage = stageFrom(role, userFacts);
    summaries.set(userId, {
      stage,
      emailsSent: mine.length,
      lastEmailAt: mine[0]?.createdAt ?? null,
      followUp: followUpStatus(stage, mine[0] ?? null),
    });
  }
  return summaries;
};

// ---- Single user ----------------------------------------------------------------------

const loadOnboardingUser = async (userId: string) => {
  const user = await userRepo().findOne({ where: { id: userId }, relations: { userRoles: true } });
  if (!user) {
    throw new NotFoundError("User not found");
  }
  if (user.userRole !== UserRole.Talent && user.userRole !== UserRole.Recruiter) {
    throw new ValidationError("Onboarding is only tracked for talents and recruiters");
  }
  const role = user.userRole as OnboardingRole;
  const facts = (await loadFacts(role, [user.id])).get(user.id)!;
  return { user, role, facts, stage: stageFrom(role, facts) };
};

/**
 * The signed-in user's own stage, for the product tour. A talent needs every profile field
 * before the pre-assessment can be generated, which is stricter than the CV-and-roles rule
 * the admin stage uses, so they stay on the profile step until it is complete.
 */
export const getMyOnboarding = async (userId: string) => {
  const { user, role, stage } = await loadOnboardingUser(userId);
  if (
    role === UserRole.Talent &&
    stage === "take_assessment" &&
    !getProfileCompletion(user).isProfileComplete
  ) {
    return { role, stage: "complete_profile" as OnboardingStage };
  }
  return { role, stage };
};

export const getUserOnboarding = async (userId: string) => {
  const { user, role, facts, stage } = await loadOnboardingUser(userId);
  const emails = await emailRepo().find({
    where: { userId },
    order: { createdAt: "DESC" },
  });
  const lastSent = emails.find((email) => email.status === "sent") ?? null;
  return {
    userId: user.id,
    role,
    stage,
    steps: stepsFrom(role, facts),
    nextSteps: nextStepsFor(role, stage),
    followUp: followUpStatus(stage, lastSent),
    emails,
  };
};

const assertStuck = (stage: OnboardingStage) => {
  if (stage === "active") {
    throw new ValidationError("This user has finished onboarding and isn't stuck");
  }
};

const daysSince = (date: Date) =>
  Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / (24 * 60 * 60 * 1000)));

export const draftOnboardingEmail = async (
  userId: string
): Promise<{ subject: string; body: string }> => {
  const { user, role, stage } = await loadOnboardingUser(userId);
  assertStuck(stage);
  const next = nextStepsFor(role, stage)!;
  const previous = await emailRepo().find({
    where: { userId, status: "sent" },
    order: { createdAt: "DESC" },
    take: 5,
  });

  let content: string | null | undefined;
  try {
    const response = await composeOnboardingEmail({
      firstName: user.firstName,
      role,
      stage,
      nextSteps: next.steps,
      ctaLabel: next.ctaLabel,
      daysSinceSignup: daysSince(user.createdAt),
      previousEmails: previous.map((email) => ({
        subject: email.subject,
        sentAt: email.createdAt.toISOString(),
      })),
    });
    content = response?.message.content;
  } catch (err) {
    logger.error(`Onboarding email draft failed for ${userId}: ${String(err)}`);
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

export interface SendOnboardingEmailPayload {
  subject: string;
  body: string;
  confirm?: boolean;
}

const assertNotOptedOut = async (userId: string): Promise<void> => {
  const user = await AppDataSource.getRepository(User).findOne({
    where: { id: userId },
    select: { id: true, followUpEmailsOptedOutAt: true },
  });
  if (user?.followUpEmailsOptedOutAt) {
    throw new ConflictError("This person unsubscribed from follow-up emails");
  }
};

export const sendOnboardingEmail = async (
  adminId: string,
  userId: string,
  payload: SendOnboardingEmailPayload
): Promise<OnboardingEmail> => {
  const subject = payload.subject.trim();
  const body = payload.body.trim();
  if (!subject || !body) {
    throw new ValidationError("Add a subject and a message");
  }
  await assertNotOptedOut(userId);
  if (subject.length > MAX_SUBJECT_LENGTH || body.length > MAX_BODY_LENGTH) {
    throw new ValidationError("The subject or message is too long");
  }

  const { user, role, stage } = await loadOnboardingUser(userId);
  assertStuck(stage);

  const lastSent = await emailRepo().findOne({
    where: { userId, status: "sent" },
    order: { createdAt: "DESC" },
  });
  if (
    lastSent &&
    Date.now() - lastSent.createdAt.getTime() < RESEND_WINDOW_MS &&
    !payload.confirm
  ) {
    throw new ConflictError(
      "This user was emailed less than 24 hours ago. Confirm to send another."
    );
  }

  const next = nextStepsFor(role, stage)!;
  const record = emailRepo().create({
    userId,
    sentById: adminId,
    stage,
    subject,
    body,
    status: "sent",
    error: null,
  });

  try {
    await new EmailService().sendOnboardingFollowUp({
      to: user.email,
      subject,
      paragraphs: body
        .split(/\n\s*\n|\n/)
        .map((line) => line.trim())
        .filter(Boolean),
      ctaLabel: next.ctaLabel,
      ctaUrl: `${env.website || "https://auxhr.com"}${next.ctaPath}`,
    });
  } catch (err) {
    record.status = "failed";
    record.error = err instanceof Error ? err.message : String(err);
    await emailRepo().save(record);
    logger.error(`Onboarding email to ${userId} failed: ${record.error}`);
    throw new AppError(502, "EMAIL_FAILED", "The email couldn't be sent. It was saved as failed.");
  }

  return emailRepo().save(record);
};
