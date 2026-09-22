import { Router } from "express";
import * as subscription from "../controllers/subscription.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess, requireVerifiedEmail } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import {
  subscriptionIdParamValidator,
  findSubscriptionValidator,
} from "../validators/subscription.js";

const router = Router();

// Subscriptions span every organization's billing — cross-tenant data, admin-only, same
// as plan.ts. There's no ownership scoping in services/subscription.ts, so anything less
// than Admin here would let any verified user list/view/enable/disable every company's
// subscription (see tests/subscription.test.ts for the regression coverage).
router.get(
  "/enable/:id",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(subscriptionIdParamValidator),
  asyncHandler(subscription.enable)
);
router.get(
  "/disable/:id",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(subscriptionIdParamValidator),
  asyncHandler(subscription.disable)
);
router.get(
  "/:id",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(subscriptionIdParamValidator),
  asyncHandler(subscription.fetchOne)
);
router.post(
  "/",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(findSubscriptionValidator),
  asyncHandler(subscription.fetchByMatch)
);
router.get(
  "/",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  asyncHandler(subscription.fetch)
);

export default (app: Router) => app.use("/subscriptions", router);
