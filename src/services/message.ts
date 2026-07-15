import { AppDataSource } from "../database/dataSource.js";
import { Message } from "../entities/Message.js";
import { Conversation } from "../entities/Conversation.js";
import { User } from "../entities/User.js";
import { Application } from "../entities/Application.js";
import { NotFoundError, AuthorizationError, ValidationError } from "../utils/errors";
import { sortDirection } from "../utils/text.js";
import { UserRole, ApplicationStatus } from "../types/enums.js";

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

  const count = await applicationRepo().count({
    where: { recruiterId, talentId, status: ApplicationStatus.Shortlisted },
  });
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

  return savedMessage;
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
  payload: { application: string; content: string }
): Promise<{ content: string }> => {
  const { application, content } = payload;

  const targetApplication = await applicationRepo().findOne({ where: { id: application } });
  if (!targetApplication) {
    throw new NotFoundError("Application not found");
  }
  if (targetApplication.recruiterId !== senderId) {
    throw new AuthorizationError("You are not authorized to perform this action");
  }

  const sender = await userRepo().findOne({ where: { id: senderId } });
  if (!sender) {
    throw new NotFoundError("Sender not found");
  }

  // Get all applications for the same job
  const applications = await applicationRepo().find({
    where: { jobId: targetApplication.jobId },
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
    });
    const savedMessage = await messageRepo().save(message);
    await conversationRepo().save({ ...conversation, lastMessageId: savedMessage.id });
  }

  return { content };
};

export const getMessages = async (
  userId: string,
  query: FetchMessagesParams
): Promise<{ messages: Message[]; unReadCount: number }> => {
  const limit = Number(query.limit) || 50;
  const offset = Number(query.offset) || 0;
  const order = sortDirection(query.sort ?? "desc");

  const qb = messageRepo()
    .createQueryBuilder("message")
    .where("(message.sender_id = :userId OR message.recipient_id = :userId)", { userId });

  if (query.application) {
    qb.andWhere("message.application_id = :application", { application: query.application });
  }

  const [messages, unReadCount] = await Promise.all([
    qb.clone().orderBy("message.createdAt", order).skip(offset).take(limit).getMany(),
    qb
      .clone()
      .andWhere("message.is_read = false")
      .andWhere("message.recipient_id = :userId", { userId })
      .getCount(),
  ]);

  return { messages, unReadCount };
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
