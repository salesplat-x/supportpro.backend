import { createHmac, timingSafeEqual } from "crypto";
import env from "../config/env.js";
import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import { StuckEmailTimer } from "../entities/StuckEmailTimer.js";
import { User } from "../entities/User.js";
import { DEFAULT_BILLING_PLAN_KEY, ScreeningStage, UserRole } from "../types/enums.js";
import { resultRows } from "../utils/durableJobs.js";
import { NotFoundError, ValidationError } from "../utils/errors";
import EmailService from "../utils/integrations/email/emailService.js";
import logger from "../utils/logger.js";
import { STAGE_LABEL, nextStepFor } from "./applicationFollowUpRules.js";
import {
  OnboardingRole,
  OnboardingStage,
  nextStepsFor,
  recruiterSteps,
  talentSteps,
} from "./onboardingRules.js";
import { getMyOnboarding, recruiterStageSql, talentStageSql } from "./onboarding.js";

const SWEEP_EVERY_MS = 15 * 60 * 1000;
const MAX_NEW_TIMERS_PER_RUN = 200;
const MAX_SENDS_PER_RUN = 50;
const MAX_SEND_ATTEMPTS = 5;
const NEW_ACCOUNT_WINDOW = "30 days";
const FIRST_EMAIL_AFTER = "24 hours";
const SECOND_EMAIL_AFTER = "48 hours";
const ONE_EMAIL_PER = "24 hours";
const STALE_CLAIM = "5 minutes";

export const ONBOARDING_SCOPE = "onboarding";
const VERIFY_EMAIL_STAGE = "verify_email";

const UNSUBSCRIBE_PURPOSE = "unsubscribe-follow-ups";

const signatureFor = (userId: string): Buffer =>
  createHmac("sha256", env.jwt_secret!).update(`${UNSUBSCRIBE_PURPOSE}:${userId}`).digest();

export const unsubscribeToken = (userId: string): string =>
  `${Buffer.from(userId).toString("base64url")}.${signatureFor(userId).toString("base64url")}`;

const userIdFromToken = (token: string): string | null => {
  const [encodedId, encodedSignature] = token.split(".");
  if (!encodedId || !encodedSignature) return null;
  const userId = Buffer.from(encodedId, "base64url").toString();
  const given = Buffer.from(encodedSignature, "base64url");
  const expected = signatureFor(userId);
  return given.length === expected.length && timingSafeEqual(given, expected) ? userId : null;
};

export const unsubscribeFromFollowUps = async (token: string): Promise<void> => {
  const userId = userIdFromToken(token);
  if (!userId) {
    throw new ValidationError("This unsubscribe link isn't valid");
  }
  const result = await AppDataSource.getRepository(User).update(
    { id: userId },
    { followUpEmailsOptedOutAt: new Date() }
  );
  if (!result.affected) {
    throw new NotFoundError("Account not found");
  }
};

/**
 * Shared by every query that decides who can get these emails. An employee hears from their
 * company, and the onboarding copy would wrongly tell them to go and apply for jobs.
 */
const eligibleUserSql = (u: string) => `
  ${u}.active = true
  AND ${u}.follow_up_emails_opted_out_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM staff_members s WHERE s.user_id = ${u}.id)`;

const onboardingCandidatesSql = (role: OnboardingRole) =>
  role === UserRole.Talent
    ? { stage: talentStageSql("u"), extra: "" }
    : {
        stage: recruiterStageSql("u").replace(
          ":onboardingFreePlan",
          `'${DEFAULT_BILLING_PLAN_KEY}'`
        ),
        // A teammate who joined a company isn't the one who should be setting it up.
        extra: `AND NOT EXISTS (
          SELECT 1 FROM organization_members m WHERE m.user_id = u.id AND m.role <> 'owner'
        )`,
      };

const startOnboardingTimers = async (role: OnboardingRole, limit: number): Promise<void> => {
  const { stage, extra } = onboardingCandidatesSql(role);
  await AppDataSource.query(
    `INSERT INTO stuck_email_timers (user_id, scope_key, stage)
     SELECT id, $1::varchar, stage FROM (
       SELECT u.id, ${stage} AS stage, u."createdAt"
       FROM users u
       WHERE u."userRole" = $2
         AND u."createdAt" >= NOW() - INTERVAL '${NEW_ACCOUNT_WINDOW}'
         AND ${eligibleUserSql("u")}
         ${extra}
     ) candidate
     WHERE stage <> 'active'
       AND NOT EXISTS (
         SELECT 1 FROM stuck_email_timers t
         WHERE t.user_id = candidate.id AND t.scope_key = $1::varchar AND t.stage = candidate.stage
       )
     ORDER BY "createdAt" DESC
     LIMIT $3
     ON CONFLICT ON CONSTRAINT "UQ_stuck_email_timers_step" DO NOTHING`,
    [ONBOARDING_SCOPE, role, limit]
  );
};

/** Only someone's newest stuck application, so several applications don't mean several emails. */
const startApplicationTimers = async (limit: number): Promise<void> => {
  await AppDataSource.query(
    `INSERT INTO stuck_email_timers (user_id, application_id, scope_key, stage)
     SELECT talent_id, id, 'application:' || id, stage FROM (
       SELECT DISTINCT ON (a.talent_id)
         a.talent_id, a.id, a."currentStage"::text AS stage
       FROM applications a
       JOIN jobs j ON j.id = a.job_id
       JOIN users u ON u.id = a.talent_id
       WHERE a.status = 'pending'
         AND a."applicationType" = 'by application'
         AND a."currentStage" NOT IN ('completed', 'cv_similarity')
         AND a."updatedAt" >= NOW() - INTERVAL '${NEW_ACCOUNT_WINDOW}'
         AND j.status = 'active'
         AND ${eligibleUserSql("u")}
       ORDER BY a.talent_id, a."updatedAt" DESC
     ) newest
     WHERE NOT EXISTS (
       SELECT 1 FROM stuck_email_timers t
       WHERE t.user_id = newest.talent_id
         AND t.scope_key = 'application:' || newest.id
         AND t.stage = newest.stage
     )
     LIMIT $1
     ON CONFLICT ON CONSTRAINT "UQ_stuck_email_timers_step" DO NOTHING`,
    [limit]
  );
};

export const startStuckTimers = async (): Promise<void> => {
  await startApplicationTimers(MAX_NEW_TIMERS_PER_RUN);
  await startOnboardingTimers(UserRole.Talent, MAX_NEW_TIMERS_PER_RUN);
  await startOnboardingTimers(UserRole.Recruiter, MAX_NEW_TIMERS_PER_RUN);
};

export const closeMovedOnTimers = async (): Promise<void> => {
  for (const role of [UserRole.Talent, UserRole.Recruiter] as OnboardingRole[]) {
    const { stage } = onboardingCandidatesSql(role);
    await AppDataSource.query(
      `UPDATE stuck_email_timers t SET closed_at = NOW()
       FROM users u
       WHERE t.user_id = u.id
         AND t.closed_at IS NULL
         AND t.scope_key = $1
         AND u."userRole" = $2
         AND (${stage}) <> t.stage`,
      [ONBOARDING_SCOPE, role]
    );
  }
  await AppDataSource.query(
    `UPDATE stuck_email_timers t SET closed_at = NOW()
     FROM applications a
     JOIN jobs j ON j.id = a.job_id
     WHERE t.application_id = a.id
       AND t.closed_at IS NULL
       AND (a."currentStage"::text <> t.stage OR a.status <> 'pending' OR j.status <> 'active')`
  );
  // Someone who starts a newer application hears about that one, not both.
  await AppDataSource.query(
    `UPDATE stuck_email_timers t SET closed_at = NOW()
     FROM (
       SELECT DISTINCT ON (a.talent_id) a.talent_id, a.id
       FROM applications a
       WHERE a.status = 'pending' AND a."applicationType" = 'by application'
       ORDER BY a.talent_id, a."updatedAt" DESC
     ) newest
     WHERE t.user_id = newest.talent_id
       AND t.application_id IS NOT NULL
       AND t.application_id <> newest.id
       AND t.closed_at IS NULL`
  );
};

const stepOf = (timer: Pick<StuckEmailTimer, "firstSentAt">): 1 | 2 => (timer.firstSentAt ? 2 : 1);

const selectDueTimers = async (): Promise<string[]> => {
  const rows: unknown = await AppDataSource.query(
    `SELECT t.id
     FROM stuck_email_timers t
     JOIN users u ON u.id = t.user_id
     WHERE t.closed_at IS NULL
       AND t.attempts < $1
       AND ${eligibleUserSql("u")}
       AND (t.claimed_at IS NULL OR t.claimed_at < NOW() - INTERVAL '${STALE_CLAIM}')
       AND (
         (t.first_sent_at IS NULL AND t.stuck_since <= NOW() - INTERVAL '${FIRST_EMAIL_AFTER}')
         OR (
           t.first_sent_at <= NOW() - INTERVAL '${SECOND_EMAIL_AFTER}'
           AND t.second_sent_at IS NULL
           AND t.stage <> $2
         )
       )
     ORDER BY t.stuck_since
     LIMIT $3`,
    [MAX_SEND_ATTEMPTS, VERIFY_EMAIL_STAGE, MAX_SENDS_PER_RUN]
  );
  return resultRows(rows).map((row) => (row as { id: string }).id);
};

/**
 * Takes the timer for this sweep. The per-user lock is transaction-scoped because the app pools
 * connections, and it makes the once-a-day check safe against another timer of theirs.
 */
const claimTimer = (timerId: string): Promise<StuckEmailTimer | null> =>
  AppDataSource.transaction(async (em) => {
    const timer = await em.getRepository(StuckEmailTimer).findOne({ where: { id: timerId } });
    if (!timer) return null;
    await em.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`stuck-email:${timer.userId}`]);

    const recent: unknown = await em.query(
      `SELECT 1 WHERE
         EXISTS (
           SELECT 1 FROM stuck_email_timers t
           WHERE t.user_id = $1
             AND (t.first_sent_at > NOW() - INTERVAL '${ONE_EMAIL_PER}'
               OR t.second_sent_at > NOW() - INTERVAL '${ONE_EMAIL_PER}'
               OR t.claimed_at > NOW() - INTERVAL '${STALE_CLAIM}')
         )
         OR EXISTS (
           SELECT 1 FROM onboarding_emails e
           WHERE e.user_id = $1 AND e.status = 'sent'
             AND e.created_at AT TIME ZONE 'UTC' > NOW() - INTERVAL '${ONE_EMAIL_PER}'
         )
         OR EXISTS (
           SELECT 1 FROM application_follow_up_emails e
           JOIN applications a ON a.id = e.application_id
           WHERE a.talent_id = $1 AND e.status = 'sent'
             AND e.created_at AT TIME ZONE 'UTC' > NOW() - INTERVAL '${ONE_EMAIL_PER}'
         )`,
      [timer.userId]
    );
    if (resultRows(recent).length > 0) return null;

    const claimed: unknown = await em.query(
      `UPDATE stuck_email_timers
       SET claimed_at = NOW(), attempts = attempts + 1
       WHERE id = $1
         AND closed_at IS NULL
         AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '${STALE_CLAIM}')
       RETURNING id`,
      [timerId]
    );
    return resultRows(claimed).length > 0 ? timer : null;
  });

const unsubscribeLinksFor = (userId: string) => {
  const token = unsubscribeToken(userId);
  const site = env.website ?? "";
  return {
    unsubscribeUrl: `${site}/unsubscribe?token=${encodeURIComponent(token)}`,
    oneClickUrl: env.publicApiUrl
      ? `${env.publicApiUrl}/v1/email-preferences/unsubscribe?token=${encodeURIComponent(token)}`
      : undefined,
  };
};

const labelFor = (role: OnboardingRole, stage: OnboardingStage): string => {
  const noFacts = {} as never;
  const steps = role === UserRole.Talent ? talentSteps(noFacts) : recruiterSteps(noFacts);
  return steps.find((step) => step.key === stage)?.label ?? "Getting started";
};

const sendOnboardingReminder = async (timer: StuckEmailTimer, user: User): Promise<void> => {
  const { role, stage } = await getMyOnboarding(user.id);
  if (stage === "active") return;
  const next = nextStepsFor(role, stage)!;
  const label = labelFor(role, stage);
  const step = stepOf(timer);
  const isVerify = stage === VERIFY_EMAIL_STAGE;

  // The first verification link expires after a day, so this email can't say to go and click it.
  const steps = isVerify
    ? [
        "Sign in to Auxhr.",
        "If your verification link has expired, you can ask for a new one there.",
      ]
    : next.steps;
  const subject =
    step === 1 ? "You're nearly set up on Auxhr" : "Still want to finish setting up on Auxhr?";
  const paragraphs = [
    step === 1
      ? `Hi ${user.firstName}, you're nearly set up on Auxhr. You stopped at this step: ${label}.`
      : `Hi ${user.firstName}, it's been a couple of days and you're still at this step: ${label}. It only takes a few minutes to finish.`,
    `What to do next: ${steps.join(" ")}`,
  ];

  await new EmailService().sendOnboardingFollowUp({
    to: user.email,
    subject,
    paragraphs,
    ctaLabel: next.ctaLabel,
    ctaUrl: `${env.website ?? ""}${next.ctaPath}`,
    automatic: { idempotencyKey: `stuck-${timer.id}-${step}`, ...unsubscribeLinksFor(user.id) },
  });
  await AppDataSource.query(
    `INSERT INTO onboarding_emails (user_id, sent_by_id, stage, subject, body, status, source)
     VALUES ($1, NULL, $2, $3, $4, 'sent', 'auto')`,
    [user.id, stage, subject, paragraphs.join("\n\n")]
  );
};

const sendApplicationReminder = async (timer: StuckEmailTimer, user: User): Promise<void> => {
  const application = await AppDataSource.getRepository(Application).findOneOrFail({
    where: { id: timer.applicationId! },
    relations: { job: { role: true, organization: true } },
  });
  const stage = application.currentStage;
  const next = nextStepFor(stage);
  const jobTitle = application.job.role?.name ?? "the role";
  const companyName = application.job.organization?.name;
  const where = companyName ? `${jobTitle} at ${companyName}` : jobTitle;
  const step = stepOf(timer);

  const subject =
    step === 1 ? `Finish your application for ${jobTitle}` : `${jobTitle} is still waiting for you`;
  const paragraphs = [
    step === 1
      ? `Hi ${user.firstName}, your application for ${where} is waiting at this step: ${STAGE_LABEL[stage]}.`
      : `Hi ${user.firstName}, it's been a couple of days and your application for ${where} is still at this step: ${STAGE_LABEL[stage]}.`,
    `What to do next: ${next.steps.join(" ")}`,
  ];

  await new EmailService().sendApplicationFollowUp({
    to: user.email,
    subject,
    jobTitle,
    companyName,
    paragraphs,
    ctaLabel: next.ctaLabel,
    ctaUrl: `${env.website ?? ""}/talentDashboard/applicationPipeline/${application.jobId}`,
    automatic: { idempotencyKey: `stuck-${timer.id}-${step}`, ...unsubscribeLinksFor(user.id) },
  });
  // The snapshot is copied in SQL because a JS date loses the microseconds its filter compares.
  await AppDataSource.query(
    `INSERT INTO application_follow_up_emails
       (application_id, sent_by_id, step, stage, application_updated_at_snapshot,
        subject, body, status, source)
     SELECT a.id, NULL,
       (SELECT COUNT(*) + 1 FROM application_follow_up_emails e WHERE e.application_id = a.id),
       $2, a."updatedAt", $3, $4, 'sent', 'auto'
     FROM applications a WHERE a.id = $1
     ON CONFLICT ON CONSTRAINT "UQ_app_follow_up_emails_app_step" DO NOTHING`,
    [application.id, stage as ScreeningStage, subject, paragraphs.join("\n\n")]
  );
};

export const sendDueStuckEmails = async (): Promise<void> => {
  for (const timerId of await selectDueTimers()) {
    try {
      const timer = await claimTimer(timerId);
      if (!timer) continue;
      const user = await AppDataSource.getRepository(User).findOneOrFail({
        where: { id: timer.userId },
      });
      const sentColumn = stepOf(timer) === 1 ? "firstSentAt" : "secondSentAt";

      await (timer.applicationId
        ? sendApplicationReminder(timer, user)
        : sendOnboardingReminder(timer, user));

      await AppDataSource.getRepository(StuckEmailTimer).update(timer.id, {
        [sentColumn]: new Date(),
        claimedAt: null,
        lastError: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Stuck email for timer ${timerId} failed: ${message}`);
      await AppDataSource.getRepository(StuckEmailTimer).update(timerId, {
        claimedAt: null,
        lastError: message,
      });
    }
  }
};

let lastRunAt = 0;

export const resetStuckEmailThrottle = (): void => {
  lastRunAt = 0;
};

/** Called from the 30-second sweep. The time is set first, so an overlapping sweep skips it. */
export const runStuckEmailSweep = async (): Promise<void> => {
  if (!env.stuckEmailsEnabled) return;
  if (Date.now() - lastRunAt < SWEEP_EVERY_MS) return;
  lastRunAt = Date.now();
  await closeMovedOnTimers();
  await startStuckTimers();
  await sendDueStuckEmails();
};
