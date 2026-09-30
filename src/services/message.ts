import { In } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Message } from "../entities/Message.js";
import { Conversation } from "../entities/Conversation.js";
import { User } from "../entities/User.js";
import { Application } from "../entities/Application.js";
import {
  NotFoundError,
  AuthorizationError,
  ValidationError,
  PlanLimitError,
} from "../utils/errors";
import { sortDirection, stripHtmlToText, htmlToParagraphs } from "../utils/text.js";
import { UserRole, ApplicationStatus } from "../types/enums.js";
import { createNotification } from "./notification.js";
import logger from "../utils/logger.js";
import { assertCompanyResourceAccess, getActiveOrganizationId } from "./organizationScope.js";
import { Organization } from "../entities/Organization.js";
import {
  assertWithinLimit,
  ensureOrganizationBillingCurrent,
  hasFlag,
  recordUsage,
} from "./entitlements.js";
import EmailService from "../utils/integrations/email/emailService.js";
import env from "../config/env.js";

const messageRepo = () => AppDataSource.getRepository(Message);

const conversationRepo = () => AppDataSource.getRepository(Conversation);

const userRepo = () => AppDataSource.getRepository(User);

const applicationRepo = () => AppDataSource.getRepository(Application);

export const findConversation = async (
  userIdA: string,
  userIdB: string
): Promise<Conversation | null> => {
  return conversationRepo()
    .createQueryBuilder("c")
    .innerJoin("c.participants", "p1", "p1.id = :a", { a: userIdA })
    .innerJoin("c.participants", "p2", "p2.id = :b", { b: userIdB })
    .leftJoinAndSelect("c.participants", "participants")
    .getOne();
};

const createConversation = async (userA: User, userB: User): Promise<Conversation> => {
  const conv = conversationRepo().create({ participants: [userA, userB] });
  return conversationRepo().save(conv);
};

/**
 * A brand-new conversation is always recruiter → talent (talents may only reply, see
 * `sendMessage`). Admins are exempt for support purposes.
 *
 * A recruiter used to need a shortlisted application first, which made Talent Search
 * results a dead end — you could find the right person and not reach them. First
 * contact is now allowed outright and the protection moved to metering: the
 * `direct_outreach` plan limit is what stops this becoming a bulk-spam channel. Only
 * the message that opens a thread is metered; replies in an existing thread are free.
 */
const canStartConversation = (userA: User, userB: User): boolean => {
  const exemptRoles = new Set([UserRole.Admin]);
  if (exemptRoles.has(userA.userRole) || exemptRoles.has(userB.userRole)) {
    return true;
  }
  return (
    (userA.userRole === UserRole.Recruiter && userB.userRole === UserRole.Talent) ||
    (userA.userRole === UserRole.Talent && userB.userRole === UserRole.Recruiter)
  );
};

/**
 * Charges one unit of `direct_outreach` for opening a thread. Throws PlanLimitError
 * (402) when the recruiter's company is out of allowance.
 */
const meterFirstContact = async (sender: User): Promise<void> => {
  if (sender.userRole !== UserRole.Recruiter) return;
  if (!sender.activeOrganizationId) return;

  const organization = await AppDataSource.getRepository(Organization).findOne({
    where: { id: sender.activeOrganizationId },
  });
  if (!organization) return;

  await assertWithinLimit(organization, DIRECT_OUTREACH_FEATURE);
  await recordUsage(organization, DIRECT_OUTREACH_FEATURE);
};

const DIRECT_OUTREACH_FEATURE = "direct_outreach";

export interface MessageInput {
  application?: string | null;
  content: string;
  recipient: string;
}

export interface FetchMessagesParams {
  application?: string;
  /** The other side of a direct (non-application) conversation, e.g. an admin viewing one talent's thread. */
  participantId?: string;
  limit?: number | string;
  offset?: number | string;
  sort?: string;
}

export type PublicMessageSender = {
  id: string;
  firstName: string;
  lastName: string;
  userRole: UserRole;
};

const toPublicSender = (sender?: User | null): PublicMessageSender | undefined => {
  if (!sender) return undefined;
  return {
    id: sender.id,
    firstName: sender.firstName,
    lastName: sender.lastName,
    userRole: sender.userRole,
  };
};

const previewOf = (html: string): string => stripHtmlToText(html).slice(0, 120);

export const sendMessage = async (senderId: string, payload: MessageInput): Promise<Message> => {
  const { application, content, recipient } = payload;

  if (senderId === recipient) {
    throw new ValidationError("You cannot message yourself");
  }

  const [sender, receiver] = await Promise.all([
    userRepo().findOne({ where: { id: senderId } }),
    userRepo().findOne({ where: { id: recipient } }),
  ]);
  if (!sender) {
    throw new NotFoundError("Sender not found");
  }
  if (!receiver) {
    throw new NotFoundError("Recipient not found");
  }

  let conversation = await findConversation(senderId, recipient);
  if (!conversation) {
    // Talents may only reply in an existing thread — they cannot open a new one.
    if (sender.userRole === UserRole.Talent) {
      throw new AuthorizationError("You can only reply to an existing conversation");
    }
    if (!canStartConversation(sender, receiver)) {
      throw new AuthorizationError("You can only start a conversation with a talent");
    }
    await meterFirstContact(sender);
    conversation = await createConversation(sender, receiver);
  }

  const message = messageRepo().create({
    conversationId: conversation.id,
    senderId,
    recipientId: recipient,
    content,
    applicationId: application ?? null,
  });

  const savedMessage = await messageRepo().save(message);

  // Update last message on conversation
  await conversationRepo().save({ ...conversation, lastMessageId: savedMessage.id });

  await notifyMessageRecipient(recipient, content);

  return savedMessage;
};

const notifyMessageRecipient = async (userId: string, htmlContent: string): Promise<void> => {
  try {
    const preview = stripHtmlToText(htmlContent).slice(0, 280);
    if (!preview) return;
    await createNotification(userId, preview, "New message");
  } catch (err) {
    logger.error(`Message notification failed for user ${userId}: ${(err as Error).message}`);
  }
};

export const acknowledge = async (
  userId: string,
  payload: { id: string; acknowledge: boolean }
): Promise<Message> => {
  const { id, acknowledge } = payload;

  const message = await messageRepo().findOne({ where: { id } });
  if (!message) {
    throw new NotFoundError("Message not found");
  }
  if (message.recipientId !== userId) {
    throw new AuthorizationError("You are not permitted to perform this action");
  }

  message.acknowledged = acknowledge;
  message.isRead = true;
  return messageRepo().save(message);
};

export interface BroadcastMessagePayload {
  application: string;
  /** Same message to every targeted talent (legacy path). */
  content?: string;
  talentIds?: string[];
  /** One drafted message per recipient — used by the AI mass-messaging flow instead of `content`. */
  messages?: { applicationId: string; subject?: string; content: string }[];
  /** Also email each recipient (in addition to the in-app message), using their personalized subject/content. */
  sendEmail?: boolean;
}

export interface BroadcastMessageResult {
  sent: number;
  emailed: number;
  emailFailures: { applicationId: string; error: string }[];
}

export const broadcastMessage = async (
  senderId: string,
  payload: BroadcastMessagePayload
): Promise<BroadcastMessageResult> => {
  const { application, content, talentIds, messages, sendEmail } = payload;

  const targetApplication = await applicationRepo().findOne({
    where: { id: application },
    relations: { job: { role: true, organization: true } },
  });
  if (!targetApplication) {
    throw new NotFoundError("Application not found");
  }
  await assertCompanyResourceAccess(
    senderId,
    UserRole.Recruiter,
    targetApplication.job.organizationId,
    targetApplication.job.postedById
  );

  const orgId = targetApplication.job.organizationId ?? (await getActiveOrganizationId(senderId));
  if (orgId) {
    const orgRepo = AppDataSource.getRepository(Organization);
    let org = await orgRepo.findOne({ where: { id: orgId } });
    if (org) {
      org = await ensureOrganizationBillingCurrent(org);
      if (!hasFlag(org, "bulk_broadcast_tools")) {
        throw new PlanLimitError(
          "Broadcast messaging requires a Pro plan or higher. Ask your organization owner to upgrade.",
          "bulk_broadcast_tools",
          org.billingPlan
        );
      }
    }
  }

  const sender = await userRepo().findOne({ where: { id: senderId } });
  if (!sender) {
    throw new NotFoundError("Sender not found");
  }

  const messageByApplicationId = new Map((messages ?? []).map((m) => [m.applicationId, m]));

  // All applicants for the job, or — when the recruiter selected a subset via
  // the bulk-actions UI, or supplied personalized per-candidate drafts —
  // just those talents.
  const scopeIds = messageByApplicationId.size > 0 ? [...messageByApplicationId.keys()] : talentIds;
  const applications = await applicationRepo().find({
    where:
      messageByApplicationId.size > 0
        ? { jobId: targetApplication.jobId, id: In(scopeIds as string[]) }
        : talentIds?.length
          ? { jobId: targetApplication.jobId, talentId: In(talentIds) }
          : { jobId: targetApplication.jobId },
    relations: { talent: true },
  });

  const jobTitle = targetApplication.job.role?.name ?? "the role";
  const companyName = targetApplication.job.organization?.name;
  const recruiterFirstName = sender.firstName;

  let sent = 0;
  let emailed = 0;
  const emailFailures: { applicationId: string; error: string }[] = [];

  for (const app of applications) {
    if (!app.talent) continue;
    const personalized = messageByApplicationId.get(app.id);
    const messageContent = personalized?.content ?? content;
    if (!messageContent) continue;

    let conversation = await findConversation(senderId, app.talentId);
    if (!conversation) {
      conversation = await createConversation(sender, app.talent);
    }
    const message = messageRepo().create({
      conversationId: conversation.id,
      senderId,
      recipientId: app.talentId,
      content: messageContent,
      applicationId: app.id,
    });
    const savedMessage = await messageRepo().save(message);
    await conversationRepo().save({ ...conversation, lastMessageId: savedMessage.id });
    await notifyMessageRecipient(app.talentId, messageContent);
    sent += 1;

    if (sendEmail) {
      try {
        await new EmailService().sendApplicantMessage({
          to: app.talent.email,
          subject: personalized?.subject || `Message from ${recruiterFirstName} about ${jobTitle}`,
          recruiterFirstName,
          jobTitle,
          companyName,
          paragraphs: htmlToParagraphs(messageContent),
          ctaUrl: `${env.website || "https://auxhr.com"}/talentDashboard/chat`,
        });
        emailed += 1;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logger.error(`Applicant message email to application ${app.id} failed: ${errorMessage}`);
        emailFailures.push({ applicationId: app.id, error: errorMessage });
      }
    }
  }

  return { sent, emailed, emailFailures };
};

export const getMessages = async (
  userId: string,
  query: FetchMessagesParams
): Promise<{
  messages: Array<Omit<Message, "sender"> & { sender?: PublicMessageSender }>;
  unReadCount: number;
}> => {
  const limit = Number(query.limit) || 50;
  const offset = Number(query.offset) || 0;
  const order = sortDirection(query.sort ?? "desc");

  if (query.application) {
    await messageRepo().update(
      { applicationId: query.application, recipientId: userId, isRead: false },
      { isRead: true }
    );
  }

  let conversationId: string | null = null;
  if (query.participantId) {
    const conversation = await findConversation(userId, query.participantId);
    if (!conversation) {
      return { messages: [], unReadCount: 0 };
    }
    conversationId = conversation.id;
    await messageRepo().update(
      { conversationId, recipientId: userId, isRead: false },
      { isRead: true }
    );
  }

  const qb = messageRepo()
    .createQueryBuilder("message")
    .leftJoinAndSelect("message.sender", "sender")
    .where("(message.sender_id = :userId OR message.recipient_id = :userId)", { userId });

  if (query.application) {
    qb.andWhere("message.application_id = :application", { application: query.application });
  }
  if (conversationId) {
    qb.andWhere("message.conversation_id = :conversationId", { conversationId });
  }

  const [messages, unReadCount] = await Promise.all([
    qb.clone().orderBy("message.createdAt", order).skip(offset).take(limit).getMany(),
    qb
      .clone()
      .andWhere("message.isRead = false")
      .andWhere("message.recipient_id = :userId", { userId })
      .getCount(),
  ]);

  return {
    messages: messages.map((message) => ({
      ...message,
      sender: toPublicSender(message.sender),
    })),
    unReadCount,
  };
};

export interface ChatSessionThread {
  applicationId: string;
  talentId: string;
  talentName: string;
  lastMessagePreview: string;
  lastMessageAt: Date;
  unreadCount: number;
}

export interface TalentChatSession {
  applicationId: string;
  recruiterId: string;
  recruiterName: string;
  companyName: string;
  jobTitle: string;
  lastMessagePreview: string;
  lastMessageAt: Date;
  unreadCount: number;
}

export interface ChatSessionGroup {
  jobId: string;
  jobTitle: string;
  threads: ChatSessionThread[];
}

// `Message` has no `jobId` column — only reachable via `message.application.jobId` —
// so this walks the joined rows once (ordered newest-first) and groups them in JS
// rather than attempting a raw SQL GROUP BY across three joined tables (item 8).
export const getRecruiterChatSessions = async (
  recruiterId: string
): Promise<ChatSessionGroup[]> => {
  const activeOrgId = await getActiveOrganizationId(recruiterId);

  const qb = messageRepo()
    .createQueryBuilder("message")
    .innerJoinAndSelect("message.application", "application")
    .innerJoinAndSelect("application.job", "job")
    .innerJoinAndSelect("application.talent", "talent");

  if (activeOrgId) {
    qb.where("job.organization_id = :activeOrgId", { activeOrgId });
  } else {
    qb.where("application.recruiterId = :recruiterId", { recruiterId });
  }

  const messages = await qb
    .andWhere("(message.senderId = :recruiterId OR message.recipientId = :recruiterId)", {
      recruiterId,
    })
    .orderBy("message.createdAt", "DESC")
    .getMany();

  const groupsByJobId = new Map<string, ChatSessionGroup>();
  const threadsByApplicationId = new Map<string, ChatSessionThread>();

  for (const message of messages) {
    const application = message.application;
    if (!application?.job || !application.talent) continue;

    let thread = threadsByApplicationId.get(application.id);
    if (!thread) {
      thread = {
        applicationId: application.id,
        talentId: application.talentId,
        talentName: `${application.talent.firstName} ${application.talent.lastName}`.trim(),
        lastMessagePreview: previewOf(message.content),
        lastMessageAt: message.createdAt,
        unreadCount: 0,
      };
      threadsByApplicationId.set(application.id, thread);

      let group = groupsByJobId.get(application.job.id);
      if (!group) {
        group = { jobId: application.job.id, jobTitle: application.job.jobBrief, threads: [] };
        groupsByJobId.set(application.job.id, group);
      }
      group.threads.push(thread);
    }

    if (message.recipientId === recruiterId && !message.isRead) {
      thread.unreadCount += 1;
    }
  }

  return Array.from(groupsByJobId.values());
};

export const getTalentChatSessions = async (talentId: string): Promise<TalentChatSession[]> => {
  const messages = await messageRepo()
    .createQueryBuilder("message")
    .innerJoinAndSelect("message.application", "application")
    .innerJoinAndSelect("application.job", "job")
    .leftJoinAndSelect("job.organization", "organization")
    .innerJoinAndSelect("application.recruiter", "recruiter")
    .where("(message.senderId = :talentId OR message.recipientId = :talentId)", { talentId })
    .orderBy("message.createdAt", "DESC")
    .getMany();

  const threadsByApplicationId = new Map<string, TalentChatSession>();

  for (const message of messages) {
    const application = message.application;
    if (!application?.job || !application.recruiter) continue;

    let thread = threadsByApplicationId.get(application.id);
    if (!thread) {
      thread = {
        applicationId: application.id,
        recruiterId: application.recruiterId,
        recruiterName:
          `${application.recruiter.firstName} ${application.recruiter.lastName}`.trim(),
        companyName: application.job.organization?.name ?? "",
        jobTitle: application.job.jobBrief,
        lastMessagePreview: previewOf(message.content),
        lastMessageAt: message.createdAt,
        unreadCount: 0,
      };
      threadsByApplicationId.set(application.id, thread);
    }

    if (message.recipientId === talentId && !message.isRead) {
      thread.unreadCount += 1;
    }
  }

  return Array.from(threadsByApplicationId.values());
};

export const getMessage = async (userId: string, messageId: string): Promise<Message> => {
  const message = await messageRepo().findOne({ where: { id: messageId } });
  if (!message) {
    throw new NotFoundError("Message not found");
  }
  if (message.senderId !== userId && message.recipientId !== userId) {
    throw new AuthorizationError("Unauthorized");
  }
  message.isRead = true;
  return messageRepo().save(message);
};
