import { Schema, model } from "mongoose";
import { IMessage } from "../../typings/message";

const messageSchema = new Schema<IMessage>(
  {
    conversation: {
      type: Schema.Types.ObjectId,
      ref: "conversation",
      required: true,
    },
    application: {
      type: Schema.Types.ObjectId,
      ref: "application",
    },
    sender: { type: Schema.Types.ObjectId, ref: "user", required: true },
    recipient: { type: Schema.Types.ObjectId, ref: "user", required: true },
    content: { type: String, required: true },
    acknowledged: { type: Boolean, default: false },
    isRead: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const Message = model<IMessage>("message", messageSchema);
export default Message;
