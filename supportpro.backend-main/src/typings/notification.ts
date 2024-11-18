import { Document, Types } from "mongoose";
import { IUser } from "./user";

export interface INotification extends Document {
  user: string | Types.ObjectId | IUser;
  message: string;
  createdAt: Date;
  deleted: boolean;
  isRead: boolean;
}
