import { EntityManager, In } from "typeorm";
import {
  AIConfig,
  Answer,
  Application,
  Conversation,
  ErrorLog,
  Feedback,
  Job,
  Message,
  Notification,
  Organization,
  Payment,
  PreScreening,
  Question,
  Scout,
  ScoutJob,
  Subscription,
  TalentEmbedding,
  User,
  AiRecommendation,
} from "../entities";
import { NotFoundError, ValidationError } from "../utils/errors";
import { UserRole } from "../types/enums.js";

/**
 * Null conversation.last_message_id for any message that is about to be deleted,
 * then delete those messages. Required because messages → conversations is NO ACTION.
 */
async function deleteMessagesAndDetachConversations(
  manager: EntityManager,
  messageIds: string[]
): Promise<void> {
  if (messageIds.length === 0) return;

  await manager
    .createQueryBuilder()
    .update(Conversation)
    .set({ lastMessageId: null })
    .where("last_message_id IN (:...messageIds)", { messageIds })
    .execute();

  await manager.delete(Message, { id: In(messageIds) });
}

async function collectMessageIds(
  manager: EntityManager,
  where: { applicationIds?: string[]; userId?: string }
): Promise<string[]> {
  const qb = manager.createQueryBuilder(Message, "message").select("message.id", "id");

  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (where.applicationIds?.length) {
    conditions.push("message.application_id IN (:...applicationIds)");
    params.applicationIds = where.applicationIds;
  }
  if (where.userId) {
    conditions.push("(message.sender_id = :userId OR message.recipient_id = :userId)");
    params.userId = where.userId;
  }

  if (conditions.length === 0) return [];

  qb.where(conditions.join(" OR "), params);
  const rows = await qb.getRawMany<{ id: string }>();
  return rows.map((r) => r.id);
}

/**
 * Fully remove a job and every dependent row that would otherwise block deletion
 * (messages → applications → answers/questions → job; orphan AI config when unused).
 * Job.job_embedding lives on the job row and is removed with it.
 */
export async function purgeJobCascade(manager: EntityManager, jobId: string): Promise<void> {
  const job = await manager.findOne(Job, { where: { id: jobId } });
  if (!job) {
    throw new NotFoundError("Job does not exist");
  }

  const applications = await manager.find(Application, {
    where: { jobId },
    select: { id: true },
  });
  const applicationIds = applications.map((a) => a.id);

  const messageIds = await collectMessageIds(manager, { applicationIds });
  await deleteMessagesAndDetachConversations(manager, messageIds);

  // ai_recommendations cascade via FK when applications are deleted
  await manager.delete(Answer, { jobId });
  if (applicationIds.length > 0) {
    await manager.delete(Application, { jobId });
  }
  await manager.delete(Question, { jobId });

  const aiConfigId = job.aiConfigId;
  await manager.delete(Job, { id: jobId });

  if (aiConfigId) {
    const stillUsed = await manager.count(Job, { where: { aiConfigId } });
    if (stillUsed === 0) {
      await manager.delete(AIConfig, { id: aiConfigId });
    }
  }
}

/**
 * Fully remove a company and every job posted under it (each job taking its own
 * applications, answers, questions and messages with it via purgeJobCascade).
 * Any recruiter currently working on this company is detached first, since
 * users.active_organization_id points back at the row being deleted.
 */
export async function purgeOrganizationCascade(
  manager: EntityManager,
  organizationId: string
): Promise<void> {
  const organization = await manager.findOne(Organization, { where: { id: organizationId } });
  if (!organization) {
    throw new NotFoundError("Company does not exist");
  }

  const jobs = await manager.find(Job, {
    where: { organizationId },
    select: { id: true },
  });
  for (const job of jobs) {
    await purgeJobCascade(manager, job.id);
  }

  await manager.update(
    User,
    { activeOrganizationId: organizationId },
    { activeOrganizationId: null }
  );
  await manager.delete(Organization, { id: organizationId });
}

/**
 * Fully remove a talent user and every associated record:
 * messages, applications (+ AI match rows), answers, personalized question rows,
 * feedback, notifications, payments, subscriptions, embeddings, pre-screenings,
 * conversation membership, error-log links.
 * There is no external object storage for CVs anymore (cvText on the user row).
 * Personality question pools stay on the job — they are shared across applicants.
 */
export async function purgeTalentCascade(manager: EntityManager, userId: string): Promise<void> {
  const user = await manager.findOne(User, { where: { id: userId } });
  if (!user) {
    throw new NotFoundError("Talent not found");
  }
  if (user.userRole !== UserRole.Talent) {
    throw new ValidationError("Only talent accounts can be deleted from this endpoint");
  }

  const applications = await manager.find(Application, {
    where: { talentId: userId },
    select: { id: true, jobId: true, personalizedQuestions: true },
  });
  const applicationIds = applications.map((a) => a.id);
  const jobIds = [...new Set(applications.map((a) => a.jobId))];
  const personalizedQuestionIds = [
    ...new Set(applications.flatMap((a) => a.personalizedQuestions ?? []).filter(Boolean)),
  ];

  const messageIds = await collectMessageIds(manager, {
    applicationIds,
    userId,
  });
  await deleteMessagesAndDetachConversations(manager, messageIds);

  if (applicationIds.length > 0) {
    await manager.delete(AiRecommendation, { applicationId: In(applicationIds) });
    await manager.delete(Application, { talentId: userId });
  }

  for (const jobId of jobIds) {
    const remaining = await manager.count(Application, { where: { jobId } });
    await manager.update(Job, { id: jobId }, { noOfApplicants: remaining });
  }

  await manager.delete(Answer, { userId });
  if (personalizedQuestionIds.length > 0) {
    await manager.delete(Question, { id: In(personalizedQuestionIds) });
  }
  await manager.delete(Feedback, { userId });
  await manager.delete(Notification, { userId });
  await manager.delete(Payment, { userId });
  await manager.delete(Subscription, { userId });
  await manager.delete(TalentEmbedding, { userId });

  // Break circular FK: users.active_prescreening_id ↔ pre_screenings.user_id
  await manager.update(User, { id: userId }, { activePreScreeningId: null });
  await manager.delete(PreScreening, { userId });

  // Soft PII unlink on non-FK error logs
  await manager.update(ErrorLog, { userId }, { userId: null });

  const participantRows: Array<{ conversation_id: string }> = await manager.query(
    `SELECT conversation_id FROM conversation_participants WHERE user_id = $1`,
    [userId]
  );
  await manager.query(`DELETE FROM conversation_participants WHERE user_id = $1`, [userId]);

  for (const row of participantRows) {
    const remaining: Array<{ c: string }> = await manager.query(
      `SELECT COUNT(*)::text AS c FROM conversation_participants WHERE conversation_id = $1`,
      [row.conversation_id]
    );
    if (Number(remaining[0]?.c ?? 0) === 0) {
      await manager.update(Conversation, { id: row.conversation_id }, { lastMessageId: null });
      await manager.delete(Message, { conversationId: row.conversation_id });
      await manager.delete(Conversation, { id: row.conversation_id });
    }
  }

  await manager.query(`DELETE FROM user_roles WHERE user_id = $1`, [userId]);
  await manager.delete(User, { id: userId });
}

/**
 * Fully remove a recruiter and every associated record: jobs they posted
 * (via purgeJobCascade), scout jobs/scouts, remaining applications, AI configs,
 * messages, notifications, payments, subscriptions, conversation membership,
 * and the companies they own (a company has exactly one owning recruiter).
 */
export async function purgeRecruiterCascade(manager: EntityManager, userId: string): Promise<void> {
  const user = await manager.findOne(User, { where: { id: userId } });
  if (!user) {
    throw new NotFoundError("Recruiter not found");
  }
  if (user.userRole !== UserRole.Recruiter) {
    throw new ValidationError("Only recruiter accounts can be deleted from this endpoint");
  }

  const jobs = await manager.find(Job, {
    where: { postedById: userId },
    select: { id: true },
  });
  for (const job of jobs) {
    await purgeJobCascade(manager, job.id);
  }

  // Break the user -> organization FK (their own active company) before
  // deleting the organizations they own, since organizations.owner_id also
  // points back at this user.
  await manager.update(User, { id: userId }, { activeOrganizationId: null });
  await manager.delete(Organization, { ownerId: userId });

  const scoutJobs = await manager.find(ScoutJob, {
    where: { postedById: userId },
    select: { id: true },
  });
  const scoutJobIds = scoutJobs.map((sj) => sj.id);

  if (scoutJobIds.length > 0) {
    await manager.delete(Scout, { scoutJobId: In(scoutJobIds) });
  }
  await manager.delete(Scout, { recruiterId: userId });
  if (scoutJobIds.length > 0) {
    await manager.delete(ScoutJob, { postedById: userId });
  }

  const remainingApplications = await manager.find(Application, {
    where: { recruiterId: userId },
    select: { id: true },
  });
  const remainingApplicationIds = remainingApplications.map((a) => a.id);

  const messageIds = await collectMessageIds(manager, {
    applicationIds: remainingApplicationIds,
    userId,
  });
  await deleteMessagesAndDetachConversations(manager, messageIds);

  if (remainingApplicationIds.length > 0) {
    await manager.delete(Application, { recruiterId: userId });
  }

  await manager.delete(AIConfig, { recruiterId: userId });
  await manager.delete(Notification, { userId });
  await manager.delete(Payment, { userId });
  await manager.delete(Subscription, { userId });

  await manager.update(ErrorLog, { userId }, { userId: null });

  const participantRows: Array<{ conversation_id: string }> = await manager.query(
    `SELECT conversation_id FROM conversation_participants WHERE user_id = $1`,
    [userId]
  );
  await manager.query(`DELETE FROM conversation_participants WHERE user_id = $1`, [userId]);

  for (const row of participantRows) {
    const remaining: Array<{ c: string }> = await manager.query(
      `SELECT COUNT(*)::text AS c FROM conversation_participants WHERE conversation_id = $1`,
      [row.conversation_id]
    );
    if (Number(remaining[0]?.c ?? 0) === 0) {
      await manager.update(Conversation, { id: row.conversation_id }, { lastMessageId: null });
      await manager.delete(Message, { conversationId: row.conversation_id });
      await manager.delete(Conversation, { id: row.conversation_id });
    }
  }

  await manager.query(`DELETE FROM user_roles WHERE user_id = $1`, [userId]);
  await manager.delete(User, { id: userId });
}
