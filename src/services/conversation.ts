import { AppDataSource } from "../database/dataSource.js";
import { Conversation } from "../entities/Conversation.js";
import { Message } from "../entities/Message.js";
import { NotFoundError, AuthorizationError } from "../utils/errors/index.js";

function conversationRepo() {
  return AppDataSource.getRepository(Conversation);
}

function messageRepo() {
  return AppDataSource.getRepository(Message);
}

export const getConversations = async (userId: string): Promise<Conversation[]> => {
  return conversationRepo()
    .createQueryBuilder("conversation")
    .innerJoin("conversation.participants", "participant", "participant.id = :userId", { userId })
    .leftJoinAndSelect("conversation.participants", "allParticipants")
    .leftJoinAndSelect("conversation.lastMessage", "lastMessage")
    .orderBy("conversation.updatedAt", "DESC")
    .getMany();
};

export const getConversation = async (
  userId: string,
  conversationId: string
): Promise<Conversation> => {
  const conversation = await conversationRepo().findOne({
    where: { id: conversationId },
    relations: { participants: true, lastMessage: true },
  });
  if (!conversation) {
    throw new NotFoundError("Conversation not found");
  }
  const isParticipant = conversation.participants.some((p) => p.id === userId);
  if (!isParticipant) {
    throw new AuthorizationError("Unauthorized");
  }
  return conversation;
};

export const conversationMessages = async (
  userId: string,
  conversationId: string
): Promise<Message[]> => {
  const conversation = await conversationRepo().findOne({
    where: { id: conversationId },
    relations: { participants: true },
  });
  if (!conversation) {
    throw new NotFoundError("Conversation not found");
  }
  const isParticipant = conversation.participants.some((p) => p.id === userId);
  if (!isParticipant) {
    throw new AuthorizationError("Unauthorized");
  }
  return messageRepo().find({
    where: { conversationId },
    order: { createdAt: "ASC" },
  });
};
