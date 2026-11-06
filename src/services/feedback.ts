import type { EntityManager } from "typeorm";
import env from "../config/env.js";
import { AppDataSource } from "../database/dataSource.js";
import { AiDraftStatus, Feedback, FeedbackTopic, ReplyEmailStatus } from "../entities/Feedback.js";
import { Notification } from "../entities/Notification.js";
import { User } from "../entities/User.js";
import { UserRole } from "../types/enums.js";
import { resultRows, STALE_LOCK_INTERVAL } from "../utils/durableJobs.js";
import { ConflictError, NotFoundError } from "../utils/errors";
import EmailService from "../utils/integrations/email/emailService.js";
import logger from "../utils/logger.js";
import { triggerSupportDraft } from "./supportAi.js";
import { SupportStatus, supportStatusRankSql, supportStatusSql } from "./supportStatus.js";

export const NOTIFICATION_TYPE_SUPPORT_REPLY = "support_reply";

const LIST_DEFAULT_LIMIT = 25;
const LIST_MAX_LIMIT = 100;
const HISTORY_LIMIT = 100;
const PREVIEW_LENGTH = 160;
const NOTIFICATION_PREVIEW_LENGTH = 140;
const EMAIL_QUOTE_LENGTH = 300;
const EMAIL_RETRY_AFTER = "2 minutes";

const feedbackRepo = () => AppDataSource.getRepository(Feedback);

const shorten = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;

export const supportPathForRole = (role: UserRole): string =>
  role === UserRole.Recruiter ? "/recruiterDashboard/support" : "/talentDashboard/support";

// ---- The user's own conversation ---------------------------------------------------------

export interface MySupportRequest {
  id: string;
  topic: FeedbackTopic | null;
  subject: string | null;
  message: string;
  createdAt: Date;
  seen: boolean;
  reply: string | null;
  repliedAt: Date | null;
}

const toMyRequest = (row: Feedback): MySupportRequest => ({
  id: row.id,
  topic: row.topic,
  subject: row.subject,
  message: row.message,
  createdAt: row.createdAt,
  seen: row.isRead,
  reply: row.reply,
  repliedAt: row.repliedAt,
});

/** Only these columns ever reach the user, so drafts and internal notes cannot leak. */
const MY_COLUMNS = {
  id: true,
  topic: true,
  subject: true,
  message: true,
  createdAt: true,
  isRead: true,
  reply: true,
  repliedAt: true,
} as const;

export interface SubmitFeedbackInput {
  message: string;
  topic?: FeedbackTopic | null;
  clientRequestId?: string | null;
}

/** Saves a request. A retry with the same clientRequestId returns the first one instead of a copy. */
export const submitFeedback = async (
  userId: string,
  input: SubmitFeedbackInput
): Promise<{ request: MySupportRequest; created: boolean }> => {
  const clientRequestId = input.clientRequestId ?? null;
  const inserted = resultRows(
    await AppDataSource.query(
      `INSERT INTO "feedback" ("user_id", "message", "topic", "client_request_id")
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ("user_id", "client_request_id") WHERE "client_request_id" IS NOT NULL
       DO NOTHING
       RETURNING "id"`,
      [userId, input.message, input.topic ?? null, clientRequestId]
    )
  ) as Array<{ id: string }>;

  const createdId = inserted[0]?.id;
  const where = createdId ? { id: createdId } : { userId, clientRequestId: clientRequestId! };
  const row = await feedbackRepo().findOne({ where, select: MY_COLUMNS });
  if (!row) {
    throw new NotFoundError("Your message couldn't be found. Please send it again.");
  }
  if (createdId) {
    void triggerSupportDraft(createdId).catch((err: Error) =>
      logger.error(`Could not start the support draft for ${createdId}: ${err.message}`)
    );
  }
  return { request: toMyRequest(row), created: !!createdId };
};

export const listMySupport = async (userId: string): Promise<MySupportRequest[]> => {
  const rows = await feedbackRepo().find({
    where: { userId },
    select: MY_COLUMNS,
    order: { createdAt: "DESC", id: "DESC" },
    take: HISTORY_LIMIT,
  });
  return rows.reverse().map(toMyRequest);
};

// ---- Admin inbox ---------------------------------------------------------------------------

export interface SupportUserSummary {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  userRole: UserRole;
  profileImageUrl: string | null;
}

export interface SupportInboxRow {
  id: string;
  topic: FeedbackTopic | null;
  subject: string | null;
  preview: string;
  status: SupportStatus;
  isRead: boolean;
  hasDraft: boolean;
  aiDraftStatus: AiDraftStatus | null;
  replyEmailStatus: ReplyEmailStatus | null;
  createdAt: Date;
  repliedAt: Date | null;
  user: SupportUserSummary;
}

export interface SupportInboxFilters {
  status?: SupportStatus;
  topic?: FeedbackTopic;
  search?: string;
  sortBy?: "status" | "createdAt";
  sort?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export type SupportCounts = Record<SupportStatus, number>;

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

const USER_SUMMARY_SQL = `json_build_object(
  'id', u."id", 'firstName', u."firstName", 'lastName', u."lastName", 'email', u."email",
  'userRole', u."userRole", 'profileImageUrl', u."profileImageUrl"
) AS "user"`;

export const listSupportInbox = async (
  filters: SupportInboxFilters = {}
): Promise<{ feedback: SupportInboxRow[]; total: number; counts: SupportCounts }> => {
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  const conditions: string[] = [];
  if (filters.topic) {
    conditions.push(`f."topic" = ${param(filters.topic)}`);
  }
  const search = filters.search?.trim();
  if (search) {
    const pattern = param(`%${escapeLike(search)}%`);
    conditions.push(`(
      (u."firstName" || ' ' || u."lastName") ILIKE ${pattern} ESCAPE '\\'
      OR u."email" ILIKE ${pattern} ESCAPE '\\'
      OR f."message" ILIKE ${pattern} ESCAPE '\\'
    )`);
  }
  const baseWhere = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRows = (await AppDataSource.query(
    `SELECT ${supportStatusSql("f")} AS "status", COUNT(*)::int AS "count"
     FROM "feedback" f JOIN "users" u ON u."id" = f."user_id"
     ${baseWhere}
     GROUP BY 1`,
    params
  )) as Array<{ status: SupportStatus; count: number }>;
  const counts: SupportCounts = { unread: 0, read: 0, unreplied: 0, replied: 0 };
  for (const row of countRows) {
    counts[row.status] = row.count;
  }
  const total = filters.status
    ? counts[filters.status]
    : counts.unread + counts.read + counts.unreplied + counts.replied;

  const rowConditions = [...conditions];
  if (filters.status) {
    rowConditions.push(`${supportStatusSql("f")} = ${param(filters.status)}`);
  }
  const direction = filters.sort === "desc" ? "DESC" : "ASC";
  const orderBy =
    filters.sortBy === "createdAt"
      ? `f."createdAt" ${filters.sort === "asc" ? "ASC" : "DESC"}, f."id" ${filters.sort === "asc" ? "ASC" : "DESC"}`
      : `${supportStatusRankSql("f")} ${direction}, f."createdAt" DESC, f."id" DESC`;
  const limit = Math.min(filters.limit || LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT);
  const offset = filters.offset ?? 0;

  const rows = (await AppDataSource.query(
    `SELECT f."id", f."topic", f."subject", LEFT(f."message", ${PREVIEW_LENGTH}) AS "preview",
       ${supportStatusSql("f")} AS "status", f."isRead",
       (f."draft_reply" IS NOT NULL) AS "hasDraft",
       f."ai_draft_status" AS "aiDraftStatus",
       f."reply_email_status" AS "replyEmailStatus",
       f."createdAt", f."replied_at" AS "repliedAt",
       ${USER_SUMMARY_SQL}
     FROM "feedback" f JOIN "users" u ON u."id" = f."user_id"
     ${rowConditions.length ? `WHERE ${rowConditions.join(" AND ")}` : ""}
     ORDER BY ${orderBy}
     LIMIT ${param(limit)} OFFSET ${param(offset)}`,
    params
  )) as SupportInboxRow[];

  return { feedback: rows, total, counts };
};

// ---- One request ---------------------------------------------------------------------------

export interface SupportRequestView {
  id: string;
  userId: string;
  topic: FeedbackTopic | null;
  subject: string | null;
  message: string;
  status: SupportStatus;
  isRead: boolean;
  createdAt: Date;
  reply: string | null;
  repliedAt: Date | null;
  replyEmailStatus: ReplyEmailStatus | null;
  replyEmailError: string | null;
  draftReply: string | null;
  draftUpdatedAt: Date | null;
  aiDraft: string | null;
  aiNote: string | null;
  aiDraftStatus: AiDraftStatus | null;
  aiDraftAttempts: number;
  aiDraftLastError: string | null;
  /** True while a background draft holds a fresh lock, so "Draft with AI" should wait. */
  aiDraftBusy: boolean;
}

const REQUEST_SQL = (alias: string) => `
  ${alias}."id", ${alias}."user_id" AS "userId", ${alias}."topic", ${alias}."subject",
  ${alias}."message", ${supportStatusSql(alias)} AS "status", ${alias}."isRead",
  ${alias}."createdAt", ${alias}."reply", ${alias}."replied_at" AS "repliedAt",
  ${alias}."reply_email_status" AS "replyEmailStatus",
  ${alias}."reply_email_error" AS "replyEmailError",
  ${alias}."draft_reply" AS "draftReply", ${alias}."draft_updated_at" AS "draftUpdatedAt",
  ${alias}."ai_draft" AS "aiDraft", ${alias}."ai_note" AS "aiNote",
  ${alias}."ai_draft_status" AS "aiDraftStatus", ${alias}."ai_draft_attempts" AS "aiDraftAttempts",
  ${alias}."ai_draft_last_error" AS "aiDraftLastError",
  (${alias}."ai_draft_status" = 'pending' AND ${alias}."ai_draft_locked_at" IS NOT NULL
    AND ${alias}."ai_draft_locked_at" > NOW() - INTERVAL '${STALE_LOCK_INTERVAL}') AS "aiDraftBusy"`;

export type SupportRequestWithUser = SupportRequestView & { user: SupportUserSummary };

export const loadSupportRequest = async (id: string): Promise<SupportRequestWithUser> => {
  const [row] = (await AppDataSource.query(
    `SELECT ${REQUEST_SQL("f")}, ${USER_SUMMARY_SQL}
     FROM "feedback" f JOIN "users" u ON u."id" = f."user_id"
     WHERE f."id" = $1`,
    [id]
  )) as SupportRequestWithUser[];
  if (!row) {
    throw new NotFoundError("Support request not found");
  }
  return row;
};

/** One request with the user's whole conversation. It changes nothing, so polling it is safe. */
export const getSupportRequest = async (id: string) => {
  const request = await loadSupportRequest(id);
  const history = (await AppDataSource.query(
    `SELECT ${REQUEST_SQL("f")} FROM "feedback" f
     WHERE f."user_id" = $1
     ORDER BY f."createdAt" DESC, f."id" DESC
     LIMIT ${HISTORY_LIMIT}`,
    [request.userId]
  )) as SupportRequestView[];
  return { request, history: history.reverse() };
};

export const supportRequestUserId = async (id: string): Promise<string> => {
  const row = await feedbackRepo().findOne({ where: { id }, select: { id: true, userId: true } });
  if (!row) {
    throw new NotFoundError("Support request not found");
  }
  return row.userId;
};

/** Tells 404 apart from "exists but the conditional update didn't match". */
const assertRequestExists = async (id: string, manager: EntityManager = AppDataSource.manager) => {
  const exists = await manager.getRepository(Feedback).exists({ where: { id } });
  if (!exists) {
    throw new NotFoundError("Support request not found");
  }
};

const updateReturningId = async (
  sql: string,
  params: unknown[],
  manager: EntityManager = AppDataSource.manager
): Promise<Array<Record<string, unknown>>> =>
  resultRows(await manager.query(sql, params)) as Array<Record<string, unknown>>;

export const markSupportRead = async (id: string) => {
  const rows = await updateReturningId(
    `UPDATE "feedback" SET "isRead" = true, "updated_at" = NOW()
     WHERE "id" = $1 RETURNING "id"`,
    [id]
  );
  if (!rows.length) {
    throw new NotFoundError("Support request not found");
  }
  return loadSupportRequest(id);
};

export const markSupportUnread = async (id: string) => {
  const rows = await updateReturningId(
    `UPDATE "feedback" SET "isRead" = false, "updated_at" = NOW()
     WHERE "id" = $1 AND "replied_at" IS NULL RETURNING "id"`,
    [id]
  );
  if (!rows.length) {
    await assertRequestExists(id);
    throw new ConflictError("This request has a reply, so it can't be marked unread");
  }
  return loadSupportRequest(id);
};

export const saveSupportDraft = async (id: string, draft: string) => {
  const rows = await updateReturningId(
    `UPDATE "feedback" SET "draft_reply" = $2, "draft_updated_at" = NOW(), "updated_at" = NOW()
     WHERE "id" = $1 AND "replied_at" IS NULL
     RETURNING "draft_reply" AS "draftReply", "draft_updated_at" AS "draftUpdatedAt"`,
    [id, draft.trim() ? draft : null]
  );
  if (!rows.length) {
    await assertRequestExists(id);
    throw new ConflictError("This request already has a reply");
  }
  return rows[0] as { draftReply: string | null; draftUpdatedAt: Date | null };
};

// ---- Replying ------------------------------------------------------------------------------

const paragraphsOf = (text: string) =>
  text
    .split(/\n\s*\n|\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const recordEmailResult = async (id: string, status: ReplyEmailStatus, error: string | null) => {
  try {
    await AppDataSource.query(
      `UPDATE "feedback" SET "reply_email_status" = $2, "reply_email_error" = $3, "updated_at" = NOW()
       WHERE "id" = $1`,
      [id, status, error]
    );
  } catch (err) {
    logger.error(
      `Could not record the support reply email result for ${id}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
};

/**
 * Sends the reply email and records the result. The idempotency key makes a retry after a
 * send that actually went through a no-op at Resend, so the user never gets it twice.
 */
const emailReply = async (
  id: string,
  user: Pick<User, "email" | "userRole">,
  reply: string,
  original: string
): Promise<void> => {
  try {
    await new EmailService().sendSupportReply({
      to: user.email,
      subject: "Auxhr support replied to your message",
      paragraphs: paragraphsOf(reply),
      quote: shorten(original.trim(), EMAIL_QUOTE_LENGTH),
      ctaLabel: "View the conversation",
      ctaUrl: `${env.website || "https://auxhr.com"}${supportPathForRole(user.userRole)}`,
      idempotencyKey: `support-reply/${id}`,
    });
    await recordEmailResult(id, "sent", null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Support reply email for ${id} failed: ${message}`);
    await recordEmailResult(id, "failed", message);
  }
};

const loadRecipient = async (manager: EntityManager, userId: string) => {
  const user = await manager.getRepository(User).findOne({
    where: { id: userId },
    select: { id: true, email: true, userRole: true },
  });
  if (!user) {
    throw new NotFoundError("The person who sent this request no longer has an account");
  }
  return user;
};

/**
 * Saves the reply and the user's notification together. The update only matches a request
 * with no reply yet, so a double click or a second tab can never send two replies.
 */
export const replyToSupportRequest = async (adminId: string, id: string, reply: string) => {
  const text = reply.trim();
  const { user, message } = await AppDataSource.transaction(async (manager) => {
    const [row] = (await updateReturningId(
      `UPDATE "feedback"
       SET "reply" = $2, "replied_at" = NOW(), "replied_by_id" = $3, "isRead" = true,
           "reply_email_status" = 'pending', "reply_email_error" = NULL,
           "draft_reply" = NULL, "draft_updated_at" = NULL, "updated_at" = NOW(),
           "ai_draft_status" = CASE WHEN "ai_draft_status" = 'pending' THEN NULL
             ELSE "ai_draft_status" END
       WHERE "id" = $1 AND "replied_at" IS NULL
       RETURNING "user_id" AS "userId", "message"`,
      [id, text, adminId],
      manager
    )) as Array<{ userId: string; message: string }>;
    if (!row) {
      await assertRequestExists(id, manager);
      throw new ConflictError("This request already has a reply");
    }

    const recipient = await loadRecipient(manager, row.userId);
    const notifications = manager.getRepository(Notification);
    await notifications.save(
      notifications.create({
        userId: recipient.id,
        title: "Support replied",
        message: shorten(text, NOTIFICATION_PREVIEW_LENGTH),
        type: NOTIFICATION_TYPE_SUPPORT_REPLY,
        link: supportPathForRole(recipient.userRole),
        organizationId: null,
        dedupeKey: `support_reply:${id}`,
      })
    );
    return { user: recipient, message: row.message };
  });

  await emailReply(id, user, text, message);
  return loadSupportRequest(id);
};

/** Sends the reply email again after it failed, or after a crash left it pending. */
export const retrySupportReplyEmail = async (id: string) => {
  const [row] = (await updateReturningId(
    `UPDATE "feedback" SET "reply_email_status" = 'pending', "updated_at" = NOW()
     WHERE "id" = $1 AND "replied_at" IS NOT NULL
       AND ("reply_email_status" = 'failed'
         OR ("reply_email_status" = 'pending'
           AND "updated_at" < NOW() - INTERVAL '${EMAIL_RETRY_AFTER}'))
     RETURNING "user_id" AS "userId", "reply", "message"`,
    [id]
  )) as Array<{ userId: string; reply: string; message: string }>;
  if (!row) {
    await assertRequestExists(id);
    throw new ConflictError("This email was already sent or is being sent right now");
  }
  const user = await loadRecipient(AppDataSource.manager, row.userId);
  await emailReply(id, user, row.reply, row.message);
  return loadSupportRequest(id);
};
