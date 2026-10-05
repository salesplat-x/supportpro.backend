import { Router } from "express";
import * as notification from "../controllers/notification.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired, requireVerifiedEmail } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  createNotificationValidator,
  notificationIdParamValidator,
} from "../validators/notification.js";

const router = Router();

router.post(
  "/",
  loginRequired,
  requireVerifiedEmail,
  validate(createNotificationValidator),
  asyncHandler(notification.create, "create notification")
);
router.get(
  "/",
  loginRequired,
  requireVerifiedEmail,
  asyncHandler(notification.getNotifications, "load notifications")
);
router.patch(
  "/read-all",
  loginRequired,
  requireVerifiedEmail,
  asyncHandler(notification.markAllRead, "mark notifications as read")
);
router.get(
  "/:id",
  loginRequired,
  requireVerifiedEmail,
  validate(notificationIdParamValidator),
  asyncHandler(notification.getNotification, "load notification")
);
router.delete(
  "/:id",
  loginRequired,
  requireVerifiedEmail,
  validate(notificationIdParamValidator),
  asyncHandler(notification.deleteNotification, "delete notification")
);

export default (app: Router) => app.use("/notifications", router);
