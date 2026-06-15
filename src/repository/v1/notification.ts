import Notification from "../../models/v1/notification";
import { Paging } from "../../typings/customs";
import { INotification } from "../../typings/notification";
import { FilterQuery, Types } from "mongoose";

export const createNotification = async (notification: Pick<INotification, "user" | "message">) => {
  return await Notification.create(notification);
};

export const insertMany = async (notifications: any) => {
  return await Notification.insertMany(notifications);
};

export const findNotificationById = async (id: Types.ObjectId | string) => {
  return await Notification.findById(id);
};

export const findNotifications = async (match: FilterQuery<INotification>, paging: Paging = {}) => {
  return await Notification.find({ ...match, deleted: false })
    .sort({ createdAt: -1 })
    .skip(Number(paging.offset))
    .limit(Number(paging.limit));
};

export const countUnreadNotifications = async (match: FilterQuery<INotification>) => {
  return await Notification.countDocuments({
    ...match,
    deleted: false,
    isRead: false,
  });
};

export const readNotification = async (notificationId: string | Types.ObjectId) => {
  return await Notification.findByIdAndUpdate(
    notificationId,
    { isRead: true },
    {
      new: true,
    }
  );
};
