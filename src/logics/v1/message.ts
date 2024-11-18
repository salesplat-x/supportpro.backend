import * as messageRepository from "../../repository/v1/message";
import * as conversationRepository from "../../repository/v1/conversation";
import { IUser } from "../../typings/user";
import {
  IBroadcastMessage,
  IFetchMessages,
  IMessageInput,
} from "../../typings/message";
import { makeResponse } from "../../helpers/response";
import { FilterQuery } from "mongoose";
import { findUserById } from "../../repository/v1/user";
import {
  findApplicationByMatch,
  findApplicationsByMatch,
} from "../../repository/v1/application";

export const sendMessage = async (user: IUser, payload: IMessageInput) => {
  const { application, content, recipient } = payload;

  if (user.id === recipient) {
    return makeResponse(false, "You cannot message yourself!");
  }
  const receiver = await findUserById(recipient as string);
  if (!receiver) {
    return makeResponse(false, "Recipient not found!", {}, 404);
  }

  let conversation = await conversationRepository.findConversation({
    participants: { $all: [user.id, recipient] },
  });

  if (!conversation) {
    conversation = await conversationRepository.createConversation({
      participants: [user.id, recipient],
    });
  }

  const message = await messageRepository.createMessage({
    conversation: conversation.id,
    sender: user.id,
    recipient,
    content,
    application,
  });
  await message.save();

  conversation.lastMessage = message.id;
  await conversation.save();

  return makeResponse(true, "Message created", { message }, 200);
};

export const acknowledge = async (
  user: IUser,
  payload: { id: string; acknowledge: boolean }
) => {
  const { id, acknowledge } = payload;

  const message = await messageRepository.findMessageById(id);
  if (!message) {
    return makeResponse(false, "Message not found!", {}, 404);
  }
  if (message.recipient.toString() !== user.id) {
    return makeResponse(false, "You permitted to perform this action!", {}, 404);
  }

  message.acknowledged = acknowledge;
  message.isRead = true;
  await message.save();

  return makeResponse(true, "Message created", { message }, 200);
};

export const broadcastMessage = async (
  user: IUser,
  payload: IBroadcastMessage
) => {
  const { application, content } = payload;

  const _application = await findApplicationByMatch({ _id: application });
  if (!_application) {
    return makeResponse(false, "Application not found!", {}, 404);
  }

  const applications = await findApplicationsByMatch({ job: _application.job });

  const conversationBulkOps = [];
  const messageBulkOps = [];

  for (const application of applications) {
    const participants = [user.id, application.talent];

    const existingConversation = await conversationRepository.findConversation({
      participants: { $all: participants },
    });

    let conversationId;
    if (existingConversation) {
      conversationId = existingConversation._id;
    } else {
      // Create new conversation and add to bulk ops
      conversationId = conversationRepository.newConversation({
        participants,
      }).id;

      conversationBulkOps.push({
        insertOne: {
          document: {
            _id: conversationId,
            participants,
          },
        },
      });
    }

    // Prepare message bulk insert operation
    const newMessage = messageRepository.newMessage({
      conversation: conversationId,
      sender: user.id,
      recipient: application.talent,
      content,
    });

    messageBulkOps.push({
      insertOne: {
        document: newMessage,
      },
    });

    // Prepare bulk update operation to update the last message in the conversation
    conversationBulkOps.push({
      updateOne: {
        filter: { _id: conversationId },
        update: { lastMessage: newMessage._id },
      },
    });
  }

  if (conversationBulkOps.length > 0) {
    await conversationRepository.bulkWriteConversation(conversationBulkOps);
  }

  if (messageBulkOps.length > 0) {
    await messageRepository.bulkWriteMessage(messageBulkOps);
  }

  return makeResponse(true, "Message created", { content }, 200);
};

export const getMessages = async (
  user: IUser,
  query: FilterQuery<IFetchMessages>
) => {
  const payload: FilterQuery<IFetchMessages> = {
    $or: [{ sender: user.id }, { recipient: user.id }],
  };

  if (query.application) {
    payload.application = query.application;
  }

  const messages = await messageRepository.findMessages(payload, query);
  const unReadCount = await messageRepository.countUnreadMessages(payload);

  return makeResponse(
    true,
    "Messages fetched successfully",
    { messages, unReadCount },
    200
  );
};

export const getMessage = async (user: IUser, messageId: string) => {
  const message = await messageRepository.findMessageById(messageId);

  if (!message) {
    return makeResponse(false, "Message not found!", {}, 404);
  }

  if (
    message.sender.toString() !== user.id &&
    message.recipient.toString() !== user.id
  ) {
    return makeResponse(false, "Unauthorized!", {}, 403);
  }
  message.isRead = true;
  await message.save();

  return makeResponse(true, "Message fetched successfully", { message }, 200);
};

// export const deleteMessage = async (user: IUser, messageId: string) => {
//   const message = await messageRepository.findMessageById(messageId);

//   if (!message) {
//     return makeResponse(false, "Message not found!", {}, 404);
//   }

//   if (message.user.toString() !== user.id) {
//     return makeResponse(false, "Unauthorized!", {}, 403);
//   }
//   message.deleted = true;
//   await message.save();

//   return makeResponse(true, "Message deleted successfully", { message }, 200);
// };

//Application/messages
