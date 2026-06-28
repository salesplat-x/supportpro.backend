import { Router } from "express";
import * as notification from "../controllers/notification.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { notificationIdParamValidator } from "../validators/notification.js";

const router = Router();

router.post("/", loginRequired, asyncHandler(notification.create));
router.get("/", loginRequired, asyncHandler(notification.getNotifications));
router.get("/:id", loginRequired, validate(notificationIdParamValidator), asyncHandler(notification.getNotification));
router.delete("/:id", loginRequired, validate(notificationIdParamValidator), asyncHandler(notification.deleteNotification));

export default (app: Router) => app.use("/notifications", router);
