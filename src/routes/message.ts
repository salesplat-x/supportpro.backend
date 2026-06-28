import { Router } from "express";
import * as message from "../controllers/message.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired, validateAccess } from "../middleware/auth.js";
import { UserRole } from "../types/enums.js";
import {
  sendMessageValidator,
  broadcastMessageValidator,
  acknowledgeMessageValidator,
  fetchMessagesQueryValidator,
  messageIdParamValidator,
} from "../validators/message.js";

const router = Router();

router.post(
  "/broadcast",
  validateAccess([UserRole.Recruiter]),
  validate(broadcastMessageValidator),
  asyncHandler(message.broadcastMessage)
);
router.patch(
  "/:id",
  validateAccess([UserRole.Talent]),
  validate(acknowledgeMessageValidator),
  asyncHandler(message.acknowledge)
);
router.post("/", loginRequired, validate(sendMessageValidator), asyncHandler(message.create));
router.get(
  "/",
  loginRequired,
  validate(fetchMessagesQueryValidator),
  asyncHandler(message.getMessages)
);
router.get(
  "/:id",
  loginRequired,
  validate(messageIdParamValidator),
  asyncHandler(message.getMessage)
);

export default (app: Router) => app.use("/messages", router);
