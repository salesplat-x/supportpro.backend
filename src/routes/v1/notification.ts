import { Router } from "express";

import * as notification from "../../controllers/v1/notification";
import { asyncHandler } from "../../middlewares/v1/handler";
import { loginRequired } from "../../middlewares/v1/auth";

const router = Router();
router.use(loginRequired);

router.post("/", asyncHandler(notification.create));

router.get("/", asyncHandler(notification.getNotifications));

router.get("/:id", asyncHandler(notification.getNotification));

router.delete("/:id", asyncHandler(notification.deleteNotification));

export default (app: Router) => app.use("/notifications", router);
