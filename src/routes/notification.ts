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
  asyncHandler(notification.create)
);
router.get(
  "/",
  loginRequired,
  requireVerifiedEmail,
  asyncHandler(notification.getNotifications)
);
router.get(
  "/:id",
  loginRequired,
  requireVerifiedEmail,
  validate(notificationIdParamValidator),
  asyncHandler(notification.getNotification)
);
router.delete(
  "/:id",
  loginRequired,
  requireVerifiedEmail,
  validate(notificationIdParamValidator),
  asyncHandler(notification.deleteNotification)
);

export default (app: Router) => app.use("/notifications", router);
