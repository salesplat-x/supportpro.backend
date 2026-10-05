import { Router } from "express";
import * as message from "../controllers/message.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired, requireVerifiedEmail, validateAccess } from "../middleware/auth.js";
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
  requireVerifiedEmail,
  validate(broadcastMessageValidator),
  asyncHandler(message.broadcastMessage, "send broadcast message")
);
router.patch(
  "/:id",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  validate(acknowledgeMessageValidator),
  asyncHandler(message.acknowledge, "acknowledge message")
);
router.post(
  "/",
  validateAccess([UserRole.Recruiter, UserRole.Admin, UserRole.Talent]),
  requireVerifiedEmail,
  validate(sendMessageValidator),
  asyncHandler(message.create, "send message")
);
router.get(
  "/sessions",
  validateAccess([UserRole.Recruiter, UserRole.Talent]),
  requireVerifiedEmail,
  asyncHandler(message.getChatSessions, "load chats")
);
router.get(
  "/",
  loginRequired,
  requireVerifiedEmail,
  validate(fetchMessagesQueryValidator),
  asyncHandler(message.getMessages, "load messages")
);
router.get(
  "/:id",
  loginRequired,
  requireVerifiedEmail,
  validate(messageIdParamValidator),
  asyncHandler(message.getMessage, "load message")
);

export default (app: Router) => app.use("/messages", router);
