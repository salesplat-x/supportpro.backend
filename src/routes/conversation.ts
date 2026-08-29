import { Router } from "express";
import * as conversation from "../controllers/conversation.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired, requireVerifiedEmail } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  conversationIdParamValidator,
  conversationMessagesValidator,
} from "../validators/conversation.js";

const router = Router();

router.get("/", loginRequired, requireVerifiedEmail, asyncHandler(conversation.getConversations));
router.get(
  "/:id",
  loginRequired,
  requireVerifiedEmail,
  validate(conversationIdParamValidator),
  asyncHandler(conversation.getConversation)
);
router.get(
  "/:id/messages",
  loginRequired,
  requireVerifiedEmail,
  validate(conversationMessagesValidator),
  asyncHandler(conversation.conversationMessages)
);

export default (app: Router) => app.use("/conversations", router);
