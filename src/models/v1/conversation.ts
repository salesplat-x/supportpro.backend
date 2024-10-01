import { Schema, model } from "mongoose";
import { IConversation } from "../../typings/conversation";

const conversationSchema = new Schema<IConversation>(
  {
    participants: [{ type: Schema.Types.ObjectId, ref: "user", required: true }],
    lastMessage: { type: Schema.Types.ObjectId, ref: "message" },
  },
  {
    timestamps: true,
  }
);

const Conversation = model<IConversation>("conversation", conversationSchema);
export default Conversation;
