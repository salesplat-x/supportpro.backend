import { Document, Types } from "mongoose";
import { IMessage } from "./message";

export interface IConversation extends Document {
  participants: string[];
  lastMessage?: string | Types.ObjectId | IMessage;
}
