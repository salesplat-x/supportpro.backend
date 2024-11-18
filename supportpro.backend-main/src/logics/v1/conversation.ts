import * as conversationRepository from "../../repository/v1/conversation";
import { IUser } from "../../typings/user";
import { makeResponse } from "../../helpers/response";
import { findMessages } from "../../repository/v1/message";

export const getConversations = async (user: IUser) => {
  const conversations = await conversationRepository.findConversations({
    participants: user.id,
  });

  return makeResponse(
    true,
    "Conversations fetched successfully",
    { conversations },
    200
  );
};

export const getConversation = async (user: IUser, conversationId: string) => {
  const conversation = await conversationRepository.findConversationById(
    conversationId
  );

  if (!conversation) {
    return makeResponse(false, "Conversation not found!", {}, 404);
  }

  if (!conversation.participants.includes(user.id)) {
    return makeResponse(false, "Unauthorized!", {}, 403);
  }

  return makeResponse(
    true,
    "Conversation fetched successfully",
    { conversation },
    200
  );
};

export const conversationMessages = async (
  user: IUser,
  conversationId: string
) => {
  const conversation = await conversationRepository.findConversationById(
    conversationId
  );

  if (!conversation) {
    return makeResponse(false, "Conversation not found!", {}, 404);
  }

  if (!conversation.participants.includes(user.id)) {
    return makeResponse(false, "Unauthorized!", {}, 403);
  }
  const messages = await findMessages({ conversation: conversation.id });

  return makeResponse(true, "Messages fetched successfully", { messages }, 200);
};
