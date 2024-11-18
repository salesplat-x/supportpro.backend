import { Router } from "express";

import * as conversation from "../../controllers/v1/conversation";
import { asyncHandler } from "../../middlewares/v1/handler";
import { loginRequired } from "../../middlewares/v1/auth";

const router = Router();
router.use(loginRequired);

router.get("/", asyncHandler(conversation.getConversations));

router.get("/:id/messages", asyncHandler(conversation.conversationMessages));

router.get("/:id", asyncHandler(conversation.getConversation));

export default (app: Router) => app.use("/conversations", router);
