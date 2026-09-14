import { In } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Message } from "../entities/Message.js";
import { Conversation } from "../entities/Conversation.js";
import { User } from "../entities/User.js";
import { Application } from "../entities/Application.js";
import { NotFoundError, AuthorizationError, ValidationError } from "../utils/errors";
import { sortDirection, stripHtmlToText } from "../utils/text.js";
import { UserRole, ApplicationStatus } from "../types/enums.js";
import { createNotification } from "./notification.js";
import logger from "../utils/logger.js";
import { assertCompanyResourceAccess, getActiveOrganizationId } from "./organizationScope.js";

const messageRepo = () => AppDataSource.getRepository(Message);

const conversationRepo = () => AppDataSource.getRepository(Conversation);

const userRepo = () => AppDataSource.getRepository(User);

const applicationRepo = () => AppDataSource.getRepository(Application);

const findConversation = async (userIdA: string, userIdB: string): Promise<Conversation | null> => {
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

// A brand-new conversation may only be started between a recruiter and a talent
// they have shortlisted — messaging is for continuing the hiring process, not
// open DMs between any two users. Once a conversation exists, replies are free
// (a subsequent status change shouldn't retroactively lock out an ongoing thread).
// Admins are exempt for support purposes.
const canStartConversation = async (userA: User, userB: User): Promise<boolean> => {
  const exemptRoles = new Set([UserRole.Admin]);
  if (exemptRoles.has(userA.userRole) || exemptRoles.has(userB.userRole)) {
    return true;
  }

  let recruiterId: string;
  let talentId: string;
  if (userA.userRole === UserRole.Recruiter && userB.userRole === UserRole.Talent) {
    recruiterId = userA.id;
    talentId = userB.id;
  } else if (userA.userRole === UserRole.Talent && userB.userRole === UserRole.Recruiter) {
    recruiterId = userB.id;
    talentId = userA.id;
  } else {
    return false;
  }

  const countQb = applicationRepo()
    .createQueryBuilder("application")
    .leftJoin("application.job", "job")
    .where("application.recruiter_id = :recruiterId", { recruiterId })
    .andWhere("application.talent_id = :talentId", { talentId })
    .andWhere("application.status = :status", { status: ApplicationStatus.Shortlisted });

  const recruiter = userA.userRole === UserRole.Recruiter ? userA : userB;
  if (recruiter.activeOrganizationId) {
    countQb.andWhere("job.organization_id = :activeOrgId", {
      activeOrgId: recruiter.activeOrganizationId,
    });
  }

  const count = await countQb.getCount();
  return count > 0;
};

export interface MessageInput {
  application?: string | null;
  content: string;
  recipient: string;
}

export interface FetchMessagesParams {
  application?: string;
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
    if (!(await canStartConversation(sender, receiver))) {
      throw new AuthorizationError(
        "You can only message a recruiter/talent you have a shortlisted application with"
      );
    }
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

export const broadcastMessage = async (
  senderId: string,
  payload: { application: string; content: string; talentIds?: string[] }
): Promise<{ content: string }> => {
  const { application, content, talentIds } = payload;

  const targetApplication = await applicationRepo().findOne({
    where: { id: application },
    relations: { job: true },
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

  const sender = await userRepo().findOne({ where: { id: senderId } });
  if (!sender) {
    throw new NotFoundError("Sender not found");
  }

  // All applicants for the job, or — when the recruiter selected a subset via
  // the bulk-actions UI — just those talents (item 5).
  const applications = await applicationRepo().find({
    where: talentIds?.length
      ? { jobId: targetApplication.jobId, talentId: In(talentIds) }
      : { jobId: targetApplication.jobId },
    relations: { talent: true },
  });

  for (const app of applications) {
    if (!app.talent) continue;
    let conversation = await findConversation(senderId, app.talentId);
    if (!conversation) {
      conversation = await createConversation(sender, app.talent);
    }
    const message = messageRepo().create({
      conversationId: conversation.id,
      senderId,
      recipientId: app.talentId,
      content,
      applicationId: app.id,
    });
    const savedMessage = await messageRepo().save(message);
    await conversationRepo().save({ ...conversation, lastMessageId: savedMessage.id });
    await notifyMessageRecipient(app.talentId, content);
  }

  return { content };
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

  const qb = messageRepo()
    .createQueryBuilder("message")
    .leftJoinAndSelect("message.sender", "sender")
    .where("(message.sender_id = :userId OR message.recipient_id = :userId)", { userId });

  if (query.application) {
    qb.andWhere("message.application_id = :application", { application: query.application });
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
