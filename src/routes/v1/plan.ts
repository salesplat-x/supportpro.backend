import { Router } from "express";

const router = Router();

import * as plan from "../../controllers/v1/plan";
import validate from "../../middlewares/v1/validators/validate";
import * as planValidator from "../../middlewares/v1/validators/plan";
import { asyncHandler } from "../../middlewares/v1/handler";
import { validateAccess } from "../../middlewares/v1/auth";
import { Roles } from "../../typings/customs";

router.post(
    "/",
    validateAccess([Roles.Admin]),
    validate(planValidator.create, { body: true }),
    asyncHandler(plan.create)
);

router.patch(
    "/:_id",
    validateAccess([Roles.Admin]),
    validate(planValidator.update, { body: true, params: true }),
    asyncHandler(plan.update)
);

router.delete(
    "/:id",
    validateAccess([Roles.Admin]),
    validate(planValidator.id, { params: true }),
    asyncHandler(plan.deleteItem)
);

router.get(
    "/:id",
    validate(planValidator.id, { params: true }),
    asyncHandler(plan.fetchOne)
);

router.get(
    "/",
    validate(planValidator.fetchPlans, { query: true }),
    asyncHandler(plan.fetch)
);

export default (app: Router) => app.use("/plans", router);
