import Conversation from "../../models/v1/conversation";
import { Page, Paging } from "../../typings/customs";
import { IConversation } from "../../typings/conversation";
import { FilterQuery, Types } from "mongoose";

export const createConversation = async (conversation: Pick<IConversation, "participants">) => {
  return await Conversation.create(conversation);
};

export const newConversation = (conversation: Pick<IConversation, "participants">) => {
  return new Conversation(conversation);
};

export const bulkWriteConversation = async (conversations: any) => {
  return await Conversation.bulkWrite(conversations);
};

export const findConversationById = async (id: Types.ObjectId | string) => {
  return await Conversation.findById(id).populate("lastMessage");
};

export const findConversation = async (match: FilterQuery<IConversation>) => {
  return await Conversation.findOne(match);
};

// export const findOrCreateConversation = async (
//   data: Pick<IConversation, "participants">
// ) => {
//   return await Conversation.findOneAndUpdate(
//     { participants: { $all: data.participants } },
//     { $setOnInsert: { participants: data.participants } },
//     {
//       upsert: true,
//       new: true,
//     }
//   );
// };

export const findConversations = async (match: FilterQuery<IConversation>, paging: Paging = {}) => {
  return await Conversation.find(match)
    .sort({ createdAt: -1 })
    .skip(Number(paging.offset))
    .limit(Number(paging.limit));
};

export const countUnreadConversations = async (match: FilterQuery<IConversation>) => {
  return await Conversation.countDocuments({
    ...match,
    deleted: false,
    isRead: false,
  });
};

export const readConversation = async (conversationId: string | Types.ObjectId) => {
  return await Conversation.findByIdAndUpdate(
    conversationId,
    { isRead: true },
    {
      new: true,
    }
  );
};
