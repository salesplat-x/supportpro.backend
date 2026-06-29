import { Router } from "express";
import * as conversation from "../controllers/conversation.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  conversationIdParamValidator,
  conversationMessagesValidator,
} from "../validators/conversation.js";

const router = Router();

router.get("/", loginRequired, asyncHandler(conversation.getConversations));
router.get(
  "/:id",
  loginRequired,
  validate(conversationIdParamValidator),
  asyncHandler(conversation.getConversation)
);
router.get(
  "/:id/messages",
  loginRequired,
  validate(conversationMessagesValidator),
  asyncHandler(conversation.conversationMessages)
);

export default (app: Router) => app.use("/conversations", router);
