import { Router } from "express";
import * as subscription from "../controllers/subscription.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { subscriptionIdParamValidator, findSubscriptionValidator } from "../validators/subscription.js";

const router = Router();

router.get("/enable/:id", loginRequired, validate(subscriptionIdParamValidator), asyncHandler(subscription.enable));
router.get("/disable/:id", loginRequired, validate(subscriptionIdParamValidator), asyncHandler(subscription.disable));
router.get("/:id", loginRequired, validate(subscriptionIdParamValidator), asyncHandler(subscription.fetchOne));
router.post("/", loginRequired, validate(findSubscriptionValidator), asyncHandler(subscription.fetchByMatch));
router.get("/", loginRequired, asyncHandler(subscription.fetch));

export default (app: Router) => app.use("/subscriptions", router);
