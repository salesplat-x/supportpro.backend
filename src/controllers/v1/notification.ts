import { Response, Request } from "express";
import * as notificationController from "../../logics/v1/notification";
import { responseHandler } from "../../middlewares/v1/handler";

export const create = async (req: Request, res: Response) => {
  const response = await notificationController.createNotification(req.user, req.body);
  return responseHandler(res, response);
};

export const getNotifications = async (req: Request, res: Response) => {
  const response = await notificationController.getNotifications(req.user, req.query);
  return responseHandler(res, response);
};

export const getNotification = async (req: Request, res: Response) => {
  const response = await notificationController.readNotification(req.user, req.params.id!);
  return responseHandler(res, response);
};

export const deleteNotification = async (req: Request, res: Response) => {
  const response = await notificationController.deleteNotification(req.user, req.params.id!);
  return responseHandler(res, response);
};
