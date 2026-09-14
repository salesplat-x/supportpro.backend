import { Request, Response } from "express";
import * as notificationService from "../services/notification.js";
import { sendSuccessResponse } from "../utils/response.js";

export const create = async (req: Request, res: Response) => {
  const result = await notificationService.createNotification(
    req.user.id,
    req.body.message ?? req.body,
    req.body.title
  );
  sendSuccessResponse(res, "Notification created", { notification: result }, 201);
};

export const getNotifications = async (req: Request, res: Response) => {
  const result = await notificationService.getNotifications(
    req.user.id,
    req.query as Record<string, string>
  );
  sendSuccessResponse(res, "Notifications fetched", result);
};

export const getNotification = async (req: Request, res: Response) => {
  const result = await notificationService.readNotification(req.user.id, req.params["id"]!);
  sendSuccessResponse(res, "Notification fetched", { notification: result });
};

export const markAllRead = async (req: Request, res: Response) => {
  const result = await notificationService.markAllNotificationsRead(req.user.id);
  sendSuccessResponse(res, "Notifications marked as read", result);
};

export const deleteNotification = async (req: Request, res: Response) => {
  await notificationService.deleteNotification(req.user.id, req.params["id"]!);
  sendSuccessResponse(res, "Notification deleted");
};
