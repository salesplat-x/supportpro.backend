import { Router } from "express";
import * as plan from "../controllers/plan.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess, requireVerifiedEmail } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import {
  createPlanValidator,
  updatePlanValidator,
  planIdParamValidator,
  fetchPlansQueryValidator,
} from "../validators/plan.js";

const router = Router();

router.post(
  "/",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(createPlanValidator),
  asyncHandler(plan.create, "create plan")
);
router.patch(
  "/:_id",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(updatePlanValidator),
  asyncHandler(plan.update, "update plan")
);
router.delete(
  "/:id",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(planIdParamValidator),
  asyncHandler(plan.deleteItem, "delete plan")
);
router.get("/:id", validate(planIdParamValidator), asyncHandler(plan.fetchOne, "load plan"));
router.get("/", validate(fetchPlansQueryValidator), asyncHandler(plan.fetch, "load plans"));

export default (app: Router) => app.use("/plans", router);
