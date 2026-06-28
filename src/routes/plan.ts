import { Router } from "express";
import * as plan from "../controllers/plan.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import { createPlanValidator, updatePlanValidator, planIdParamValidator, fetchPlansQueryValidator } from "../validators/plan.js";

const router = Router();

router.post("/", validateAccess([UserRole.Admin]), validate(createPlanValidator), asyncHandler(plan.create));
router.patch("/:_id", validateAccess([UserRole.Admin]), validate(updatePlanValidator), asyncHandler(plan.update));
router.delete("/:id", validateAccess([UserRole.Admin]), validate(planIdParamValidator), asyncHandler(plan.deleteItem));
router.get("/:id", validate(planIdParamValidator), asyncHandler(plan.fetchOne));
router.get("/", validate(fetchPlansQueryValidator), asyncHandler(plan.fetch));

export default (app: Router) => app.use("/plans", router);
