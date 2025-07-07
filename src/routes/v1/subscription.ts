import { Router } from "express";

const router = Router();

import * as subscription from "../../controllers/v1/subscription";
import validate from "../../middlewares/v1/validators/validate";
import * as subscriptionValidator from "../../middlewares/v1/validators/subscription";
import { asyncHandler } from "../../middlewares/v1/handler";
import {loginRequired, validateAccess} from "../../middlewares/v1/auth";
import { Roles } from "../../typings/customs";

router.post(
    "/",
    validateAccess([Roles.Admin]),
    validate(subscriptionValidator.create, { body: true }),
    asyncHandler(subscription.create)
);


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

router.get(
    "/",
    validateAccess([Roles.Admin]),
    validate(subscriptionValidator.find, {body: true}),
    asyncHandler(subscription.fetchByMatch)
)

router.get(
    "/",
    validateAccess([Roles.Admin]),
    asyncHandler(subscription.fetch)
);

export default (app: Router) => app.use("/subscriptions", router);
