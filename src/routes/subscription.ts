import { Router } from "express";
import * as subscription from "../controllers/subscription.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired, requireVerifiedEmail } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  subscriptionIdParamValidator,
  findSubscriptionValidator,
} from "../validators/subscription.js";

const router = Router();

router.get(
  "/enable/:id",
  loginRequired,
  requireVerifiedEmail,
  validate(subscriptionIdParamValidator),
  asyncHandler(subscription.enable)
);
router.get(
  "/disable/:id",
  loginRequired,
  requireVerifiedEmail,
  validate(subscriptionIdParamValidator),
  asyncHandler(subscription.disable)
);
router.get(
  "/:id",
  loginRequired,
  requireVerifiedEmail,
  validate(subscriptionIdParamValidator),
  asyncHandler(subscription.fetchOne)
);
router.post(
  "/",
  loginRequired,
  requireVerifiedEmail,
  validate(findSubscriptionValidator),
  asyncHandler(subscription.fetchByMatch)
);
router.get("/", loginRequired, requireVerifiedEmail, asyncHandler(subscription.fetch));

export default (app: Router) => app.use("/subscriptions", router);
