import { Router } from "express";
import * as feedback from "../controllers/feedback.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireVerifiedEmail, validateAccess } from "../middleware/auth.js";
import { supportSubmitLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import {
  submitFeedbackValidator,
  listFeedbackQueryValidator,
  feedbackIdParamValidator,
  saveDraftValidator,
  replyValidator,
} from "../validators/feedback.js";

const router = Router();
const userAccess = validateAccess([UserRole.Talent, UserRole.Recruiter]);
const adminAccess = validateAccess([UserRole.Admin]);

router.post(
  "/",
  userAccess,
  requireVerifiedEmail,
  supportSubmitLimiter,
  validate(submitFeedbackValidator),
  asyncHandler(feedback.submitFeedback, "send your message")
);
router.get(
  "/mine",
  userAccess,
  requireVerifiedEmail,
  asyncHandler(feedback.listMine, "load your support conversation")
);
router.get(
  "/",
  adminAccess,
  requireVerifiedEmail,
  validate(listFeedbackQueryValidator),
  asyncHandler(feedback.getFeedback, "load support requests")
);
router.get(
  "/:id",
  adminAccess,
  requireVerifiedEmail,
  validate(feedbackIdParamValidator),
  asyncHandler(feedback.getRequest, "load the support request")
);
router.get(
  "/:id/user-context",
  adminAccess,
  requireVerifiedEmail,
  validate(feedbackIdParamValidator),
  asyncHandler(feedback.getUserContext, "load details about this user")
);
router.patch(
  "/:id/read",
  adminAccess,
  requireVerifiedEmail,
  validate(feedbackIdParamValidator),
  asyncHandler(feedback.markRead, "mark the request as read")
);
router.patch(
  "/:id/unread",
  adminAccess,
  requireVerifiedEmail,
  validate(feedbackIdParamValidator),
  asyncHandler(feedback.markUnread, "mark the request as unread")
);
router.put(
  "/:id/draft",
  adminAccess,
  requireVerifiedEmail,
  validate(saveDraftValidator),
  asyncHandler(feedback.saveDraft, "save the draft")
);
router.post(
  "/:id/reply",
  adminAccess,
  requireVerifiedEmail,
  validate(replyValidator),
  asyncHandler(feedback.reply, "send the reply")
);
router.post(
  "/:id/reply/email",
  adminAccess,
  requireVerifiedEmail,
  validate(feedbackIdParamValidator),
  asyncHandler(feedback.retryReplyEmail, "retry the reply email")
);

export default (app: Router) => app.use("/feedback", router);
