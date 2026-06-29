import { AppDataSource } from "../database/dataSource.js";
import { Notification } from "../entities/Notification.js";
import { NotFoundError, AuthorizationError } from "../utils/errors/index.js";
import { sortDirection } from "../utils/text.js";

const notificationRepo = () => AppDataSource.getRepository(Notification);

const MAX_PAGE_SIZE = 100;

export interface PagingParams {
  limit?: number | string;
  offset?: number | string;
  sort?: string;
}

export const createNotification = async (
  userId: string,
  message: string
): Promise<Notification> => {
  const notification = notificationRepo().create({ userId, message });
  return notificationRepo().save(notification);
};

export const getNotifications = async (
  userId: string,
  paging: PagingParams
): Promise<{ notifications: Notification[]; unReadCount: number }> => {
  const limit = Math.min(Number(paging.limit) || 50, MAX_PAGE_SIZE);
  const offset = Number(paging.offset) || 0;
  const order = sortDirection(paging.sort ?? "desc");

  const [notifications, unReadCount] = await Promise.all([
    notificationRepo().find({
      where: { userId, deleted: false },
      skip: offset,
      take: limit,
      order: { createdAt: order },
    }),
    notificationRepo().count({ where: { userId, isRead: false, deleted: false } }),
  ]);

  return { notifications, unReadCount };
};

export const readNotification = async (
  userId: string,
  notificationId: string
): Promise<Notification> => {
  const notification = await notificationRepo().findOne({ where: { id: notificationId } });
  if (!notification) {
    throw new NotFoundError("Notification not found");
  }
  if (notification.userId !== userId) {
    throw new AuthorizationError("Unauthorized");
  }
  notification.isRead = true;
  return notificationRepo().save(notification);
};

export const deleteNotification = async (
  userId: string,
  notificationId: string
): Promise<Notification> => {
  const notification = await notificationRepo().findOne({ where: { id: notificationId } });
  if (!notification) {
    throw new NotFoundError("Notification not found");
  }
  if (notification.userId !== userId) {
    throw new AuthorizationError("Unauthorized");
  }
  notification.deleted = true;
  return notificationRepo().save(notification);
};
