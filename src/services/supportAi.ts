import { AppDataSource } from "../database/dataSource.js";
import { Feedback, FEEDBACK_TEXT_MAX_LENGTH } from "../entities/Feedback.js";
import {
  MAX_DURABLE_ATTEMPTS,
  STALE_LOCK_INTERVAL,
  STALE_LOCK_MS,
  SWEEP_BATCH_SIZE,
  claimRowById,
  durableFailureUpdate,
  errorMessage,
  resultRows,
  selectDueIds,
} from "../utils/durableJobs.js";
import { AppError, ConflictError, NotFoundError, ValidationError } from "../utils/errors";
import { composeSupportReply } from "../utils/integrations/openai.js";
import logger from "../utils/logger.js";
import { withAiClaim } from "./peopleAi.js";
import { buildSupportContext, SupportContext } from "./supportContext.js";

const NOTE_MAX_LENGTH = 500;
const EARLIER_REQUEST_LIMIT = 10;
const EARLIER_TEXT_LIMIT = 1000;

const feedbackRepo = () => AppDataSource.getRepository(Feedback);

export interface SupportDraft {
  complexity: "simple" | "complex";
  reply: string | null;
  note: string;
}

/** Reads the AI's answer. Anything unclear counts as complex, because leaving it to the admin is the safe side. */
export const sanitizeSupportDraft = (content: string | null | undefined): SupportDraft => {
  if (!content) {
    throw new ValidationError("The AI returned nothing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ValidationError("The AI returned an unreadable draft");
  }
  const { complexity, reply, note } = (parsed ?? {}) as Record<string, unknown>;
  const replyText = typeof reply === "string" ? reply.trim() : "";
  if (replyText.length > FEEDBACK_TEXT_MAX_LENGTH) {
    throw new ValidationError("The AI draft is too long");
  }
  const noteText = typeof note === "string" ? note.trim().slice(0, NOTE_MAX_LENGTH) : "";
  const simple =
    typeof complexity === "string" && complexity.trim().toLowerCase() === "simple" && !!replyText;
  return { complexity: simple ? "simple" : "complex", reply: replyText || null, note: noteText };
};

const cut = (text: string | null) =>
  text && text.length > EARLIER_TEXT_LIMIT ? `${text.slice(0, EARLIER_TEXT_LIMIT)}…` : text;

/** Only what the AI needs: no email, surname, internal ids or anything about other people. */
const aiSnapshot = (
  context: SupportContext,
  earlier: Array<Pick<Feedback, "message" | "reply" | "createdAt" | "repliedAt">>
): Record<string, unknown> => ({
  account: {
    firstName: context.account.firstName,
    role: context.account.role,
    country: context.account.country,
    daysSinceSignup: context.account.daysSinceSignup,
    emailVerified: context.account.emailVerified,
    active: context.account.active,
  },
  onboarding: context.onboarding,
  talent: context.talent,
  recruiter: context.recruiter && {
    ...context.recruiter,
    organization: context.recruiter.organization && {
      name: context.recruiter.organization.name,
      status: context.recruiter.organization.status,
      memberRole: context.recruiter.organization.memberRole,
      teamSize: context.recruiter.organization.teamSize,
      pendingInvites: context.recruiter.organization.pendingInvites,
    },
  },
  recentErrors: context.recentErrors,
  earlierRequests: earlier.map((item) => ({
    sentAt: item.createdAt,
    message: cut(item.message),
    reply: cut(item.reply),
    repliedAt: item.repliedAt,
  })),
});

const draftFor = async (id: string): Promise<SupportDraft> => {
  const request = await feedbackRepo().findOne({
    where: { id },
    select: { id: true, userId: true, topic: true, message: true },
  });
  if (!request) {
    throw new NotFoundError("Support request not found");
  }
  const context = await buildSupportContext(request.userId);
  const earlier = await feedbackRepo()
    .createQueryBuilder("feedback")
    .select(["feedback.message", "feedback.reply", "feedback.createdAt", "feedback.repliedAt"])
    .where("feedback.userId = :userId", { userId: request.userId })
    .andWhere("feedback.id != :id", { id })
    .orderBy("feedback.createdAt", "DESC")
    .take(EARLIER_REQUEST_LIMIT)
    .getMany();

  const choice = await composeSupportReply({
    snapshot: aiSnapshot(context, earlier.reverse()),
    topic: request.topic,
    message: request.message,
  });
  return sanitizeSupportDraft(choice?.message.content);
};

// ---- Automatic drafts on arrival -------------------------------------------------------

const CLAIM_SQL = `
  UPDATE "feedback" SET "ai_draft_locked_at" = NOW()
  WHERE "id" = $1
    AND "ai_draft_status" = 'pending'
    AND "replied_at" IS NULL
    AND "ai_draft_attempts" < ${MAX_DURABLE_ATTEMPTS}
    AND ("ai_draft_next_retry_at" IS NULL OR "ai_draft_next_retry_at" <= NOW())
    AND ("ai_draft_locked_at" IS NULL OR "ai_draft_locked_at" < NOW() - INTERVAL '${STALE_LOCK_INTERVAL}')
  RETURNING "id"
`;

const DUE_SQL = `
  SELECT "id" FROM "feedback"
  WHERE "ai_draft_status" = 'pending'
    AND "replied_at" IS NULL
    AND "ai_draft_attempts" < $1
    AND ("ai_draft_next_retry_at" IS NULL OR "ai_draft_next_retry_at" <= NOW())
    AND ("ai_draft_locked_at" IS NULL OR "ai_draft_locked_at" < NOW() - INTERVAL '${STALE_LOCK_INTERVAL}')
  ORDER BY "createdAt" ASC
  LIMIT $2
`;

/** Writes only while the row is still pending, so a late or duplicate result changes nothing. */
const saveAutoDraft = async (id: string, draft: SupportDraft): Promise<void> => {
  const simple = draft.complexity === "simple";
  await AppDataSource.query(
    `UPDATE "feedback"
     SET "ai_draft" = $2, "ai_note" = $3, "ai_draft_status" = $4, "ai_draft_locked_at" = NULL,
         "ai_draft_next_retry_at" = NULL, "ai_draft_last_error" = NULL, "updated_at" = NOW()
     WHERE "id" = $1 AND "ai_draft_status" = 'pending' AND "replied_at" IS NULL`,
    [id, simple ? draft.reply : null, draft.note || null, simple ? "drafted" : "complex"]
  );
};

const recordDraftFailure = async (id: string, err: unknown): Promise<void> => {
  try {
    const row = await feedbackRepo().findOne({
      where: { id },
      select: { id: true, aiDraftAttempts: true },
    });
    if (!row) return;
    const patch = durableFailureUpdate(row.aiDraftAttempts, err);
    await AppDataSource.query(
      `UPDATE "feedback"
       SET "ai_draft_attempts" = $2, "ai_draft_next_retry_at" = $3, "ai_draft_locked_at" = NULL,
           "ai_draft_last_error" = $4,
           "ai_draft_status" = CASE WHEN $5::boolean THEN 'failed' ELSE "ai_draft_status" END,
           "updated_at" = NOW()
       WHERE "id" = $1 AND "ai_draft_status" = 'pending'`,
      [id, patch.attempts, patch.nextRetryAt, patch.lastError.slice(0, 1000), patch.exhausted]
    );
  } catch (recordErr) {
    logger.error(
      `Could not record the support draft failure for ${id}: ${errorMessage(recordErr)}`
    );
  }
};

/** Drafts one request in the background. Safe to call twice: only one caller wins the claim. */
export const triggerSupportDraft = async (id: string): Promise<void> => {
  if (!(await claimRowById(CLAIM_SQL, id))) return;
  try {
    await saveAutoDraft(id, await draftFor(id));
  } catch (err) {
    logger.error(`Support draft for ${id} failed: ${errorMessage(err)}`);
    await recordDraftFailure(id, err);
  }
};

/** Picks up drafts lost to a restart or waiting for a retry. Runs them one at a time. */
export const reconcileDueSupportDrafts = async (): Promise<{ scanned: number }> => {
  const ids = await selectDueIds(DUE_SQL, [MAX_DURABLE_ATTEMPTS, SWEEP_BATCH_SIZE]);
  for (const id of ids) {
    await triggerSupportDraft(id);
  }
  return { scanned: ids.length };
};

// ---- Drafting when the admin asks ------------------------------------------------------

/** The admin's "Draft with AI". It always keeps the reply, even for a complex request. */
export const draftSupportReplyNow = async (id: string): Promise<void> => {
  const row = await feedbackRepo().findOne({
    where: { id },
    select: { id: true, repliedAt: true, aiDraftStatus: true, aiDraftLockedAt: true },
  });
  if (!row) {
    throw new NotFoundError("Support request not found");
  }
  if (row.repliedAt) {
    throw new ConflictError("This request already has a reply");
  }
  if (
    row.aiDraftStatus === "pending" &&
    row.aiDraftLockedAt &&
    Date.now() - row.aiDraftLockedAt.getTime() < STALE_LOCK_MS
  ) {
    throw new ConflictError("The AI is drafting this right now. Give it a moment and refresh.");
  }

  await withAiClaim(`support-draft:${id}`, async () => {
    let draft: SupportDraft;
    try {
      draft = await draftFor(id);
    } catch (err) {
      if (err instanceof NotFoundError) throw err;
      logger.error(`Support draft for ${id} failed: ${errorMessage(err)}`);
      throw new AppError(
        502,
        "AI_UNAVAILABLE",
        "The AI couldn't write a draft right now. Please try again."
      );
    }
    if (!draft.reply) {
      throw new AppError(502, "AI_UNAVAILABLE", "The AI didn't write a reply. Please try again.");
    }
    const saved = resultRows(
      await AppDataSource.query(
        `UPDATE "feedback"
         SET "ai_draft" = $2, "ai_note" = $3, "ai_draft_status" = 'drafted',
             "ai_draft_locked_at" = NULL, "ai_draft_next_retry_at" = NULL,
             "ai_draft_last_error" = NULL, "updated_at" = NOW()
         WHERE "id" = $1 AND "replied_at" IS NULL
         RETURNING "id"`,
        [id, draft.reply, draft.note || null]
      )
    );
    if (!saved.length) {
      throw new ConflictError("This request already has a reply");
    }
  });
};
