import { AppDataSource } from "../database/dataSource.js";
import { Message } from "../entities/Message.js";
import { Conversation } from "../entities/Conversation.js";
import { User } from "../entities/User.js";
import { Application } from "../entities/Application.js";
import { NotFoundError, AuthorizationError, ValidationError } from "../utils/errors/index.js";
import { sortDirection } from "../utils/text.js";

function messageRepo() {
  return AppDataSource.getRepository(Message);
}

function conversationRepo() {
  return AppDataSource.getRepository(Conversation);
}

function userRepo() {
  return AppDataSource.getRepository(User);
}

function applicationRepo() {
  return AppDataSource.getRepository(Application);
}

async function findOrCreateConversation(
  userIdA: string,
  userIdB: string
): Promise<Conversation> {
  // Find existing conversation where both users are participants
  const existing = await conversationRepo()
    .createQueryBuilder("c")
    .innerJoin("c.participants", "p1", "p1.id = :a", { a: userIdA })
    .innerJoin("c.participants", "p2", "p2.id = :b", { b: userIdB })
    .leftJoinAndSelect("c.participants", "participants")
    .getOne();

  if (existing) return existing;

  const userA = await userRepo().findOne({ where: { id: userIdA } });
  const userB = await userRepo().findOne({ where: { id: userIdB } });
  if (!userA || !userB) throw new NotFoundError("User not found");

  const conv = conversationRepo().create({ participants: [userA, userB] });
  return conversationRepo().save(conv);
}

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

export const sendMessage = async (
  senderId: string,
  payload: MessageInput
): Promise<Message> => {
  const { application, content, recipient } = payload;

  if (senderId === recipient) {
    throw new ValidationError("You cannot message yourself");
  }

  const receiver = await userRepo().findOne({ where: { id: recipient } });
  if (!receiver) {
    throw new NotFoundError("Recipient not found");
  }

  const conversation = await findOrCreateConversation(senderId, recipient);

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

  // Get all applications for the same job
  const applications = await applicationRepo().find({
    where: { jobId: targetApplication.jobId },
  });

  for (const app of applications) {
    const conversation = await findOrCreateConversation(senderId, app.talentId);
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
    qb
      .clone()
      .orderBy("message.createdAt", order)
      .skip(offset)
      .take(limit)
      .getMany(),
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
