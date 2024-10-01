import { Schema, model } from "mongoose";
import { INotification } from "../../typings/notification";

const notificationSchema = new Schema<INotification>({
  user: { type: Schema.Types.ObjectId, ref: "user", required: true },
  message: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  deleted: { type: Boolean, default: false },
  isRead: { type: Boolean, default: false },
});

notificationSchema.index({ user: 1 });

const Notification = model<INotification>("notification", notificationSchema);
export default Notification;
