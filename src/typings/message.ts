import { Document, Types } from "mongoose";
import { IConversation } from "./conversation";
import { IUser } from "./user";
import { IApplication } from "./application";
import { Paging } from "./customs";

export interface IBroadcastMessage {
  application: string;
  content: string;
}

export interface IMessageInput {
  application: string | Types.ObjectId | IApplication;
  recipient: string | Types.ObjectId | IUser;
  content: string;
}

export interface IMessage extends IMessageInput, Document {
  conversation: string | Types.ObjectId | IConversation;
  sender: string | Types.ObjectId | IUser;
  acknowledged: boolean;
  isRead: boolean;
  deleted: boolean;
}

export interface IFetchMessages extends Paging {
  application: string;
}
