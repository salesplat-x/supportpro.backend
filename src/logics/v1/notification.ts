import * as notificationRepository from "../../repository/v1/notification";
import { IUser } from "../../typings/user";
import { INotification } from "../../typings/notification";
import { makeResponse } from "../../helpers/response";
import { Paging } from "../../typings/customs";
import { FilterQuery } from "mongoose";

export const createNotification = async (
  user: IUser,
  payload: INotification
) => {
  payload.user = user.id;
  const notification = await notificationRepository.createNotification(payload);

  return makeResponse(true, "Notification created", { notification }, 200);
};

export const getNotifications = async (user: IUser, paging: Paging) => {
  const query: FilterQuery<INotification> = { user: user.id };
  const notifications = await notificationRepository.findNotifications(
    query,
    paging
  );
  const unReadCount = await notificationRepository.countUnreadNotifications(
    query
  );

  return makeResponse(
    true,
    "Notification fetched successfully",
    { notifications, unReadCount },
    200
  );
};

export const readNotification = async (user: IUser, notificationId: string) => {
  const notification = await notificationRepository.findNotificationById(
    notificationId
  );

  if (!notification) {
    return makeResponse(false, "Notification not found!", {}, 404);
  }

  if (notification.user.toString() !== user.id) {
    return makeResponse(false, "Unauthorized!", {}, 403);
  }
  notification.isRead = true;
  await notification.save();

  return makeResponse(
    true,
    "Notification fetched successfully",
    { notification },
    200
  );
};

export const deleteNotification = async (
  user: IUser,
  notificationId: string
) => {
  const notification = await notificationRepository.findNotificationById(
    notificationId
  );

  if (!notification) {
    return makeResponse(false, "Notification not found!", {}, 404);
  }

  if (notification.user.toString() !== user.id) {
    return makeResponse(false, "Unauthorized!", {}, 403);
  }
  notification.deleted = true;
  await notification.save();

  return makeResponse(
    true,
    "Notification deleted successfully",
    { notification },
    200
  );
};
