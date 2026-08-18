import { Router } from "express";
import * as feedback from "../controllers/feedback.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired, validateAccess } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import {
  submitFeedbackValidator,
  listFeedbackQueryValidator,
  feedbackIdParamValidator,
} from "../validators/feedback.js";

const router = Router();

router.post(
  "/",
  loginRequired,
  validate(submitFeedbackValidator),
  asyncHandler(feedback.submitFeedback)
);
router.get(
  "/",
  validateAccess([UserRole.Admin]),
  validate(listFeedbackQueryValidator),
  asyncHandler(feedback.getFeedback)
);
router.patch(
  "/:id/read",
  validateAccess([UserRole.Admin]),
  validate(feedbackIdParamValidator),
  asyncHandler(feedback.markRead)
);
router.patch(
  "/:id/unread",
  validateAccess([UserRole.Admin]),
  validate(feedbackIdParamValidator),
  asyncHandler(feedback.markUnread)
);

export default (app: Router) => app.use("/feedback", router);
