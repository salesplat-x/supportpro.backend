import { Router } from "express";

const router = Router();

import * as subscription from "../../controllers/v1/subscription";
import validate from "../../middlewares/v1/validators/validate";
import * as subscriptionValidator from "../../middlewares/v1/validators/subscription";
import { asyncHandler } from "../../middlewares/v1/handler";
import { loginRequired } from "../../middlewares/v1/auth";

router.get(
  "/enable/:id",
  loginRequired,
  validate(subscriptionValidator.id, { params: true }),
  asyncHandler(subscription.enable)
);

router.get(
  "/disable/:id",
  loginRequired,
  validate(subscriptionValidator.id, { params: true }),
  asyncHandler(subscription.disable)
);

router.get(
  "/:id",
  loginRequired,
  validate(subscriptionValidator.id, { params: true }),
  asyncHandler(subscription.fetchOne)
);

router.post(
  "/",
  loginRequired,
  validate(subscriptionValidator.find, { body: true }),
  asyncHandler(subscription.fetchByMatch)
);

router.get("/", loginRequired, asyncHandler(subscription.fetch));

export default (app: Router) => app.use("/subscriptions", router);
