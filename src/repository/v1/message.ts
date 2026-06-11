import Message from "../../models/v1/message";
import { Page, Paging } from "../../typings/customs";
import { IMessage } from "../../typings/message";
import { FilterQuery, Types } from "mongoose";

export const createMessage = async (message: Partial<IMessage>) => {
  return await Message.create(message);
};

export const newMessage = (message: Partial<IMessage>) => {
  return new Message(message);
};

export const bulkWriteMessage = async (messages: any) => {
  return await Message.bulkWrite(messages);
};

export const findMessageById = async (id: Types.ObjectId | string) => {
  return await Message.findById(id);
};

export const findMessages = async (match: FilterQuery<IMessage>, paging: Paging = {}) => {
  return await Message.find({ ...match, deleted: false })
    .sort({ createdAt: -1 })
    .skip(Number(paging.offset))
    .limit(Number(paging.limit))
    .populate({
      path: "sender",
      select: "firstName lastName",
    });
};

export const countUnreadMessages = async (match: FilterQuery<IMessage>) => {
  return await Message.countDocuments({
    ...match,
    deleted: false,
    isRead: false,
  });
};

export const readMessage = async (messageId: string | Types.ObjectId) => {
  return await Message.findByIdAndUpdate(
    messageId,
    { isRead: true },
    {
      new: true,
    }
  );
};
