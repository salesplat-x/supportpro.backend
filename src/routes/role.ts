import { Router } from "express";
import * as role from "../controllers/role.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess, requireVerifiedEmail } from "../middleware/auth.js";
import { UserRole } from "../types/enums.js";
import {
  createRoleValidator,
  roleIdParamValidator,
  allRolesQueryValidator,
  roleQuestionsValidator,
  updateRoleValidator,
} from "../validators/role.js";

const router = Router();

router.post(
  "/",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(createRoleValidator),
  asyncHandler(role.create, "create role")
);
router.get("/", validate(allRolesQueryValidator), asyncHandler(role.fetchAll, "load roles"));
router.get(
  "/:_id/questions",
  validate(roleQuestionsValidator),
  asyncHandler(role.questions, "load role questions")
);
router.get("/:_id", validate(roleIdParamValidator), asyncHandler(role.fetch, "load role"));
router.patch(
  "/:_id",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate([...roleIdParamValidator, ...updateRoleValidator]),
  asyncHandler(role.update, "update role")
);
router.delete(
  "/:_id",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(roleIdParamValidator),
  asyncHandler(role.remove, "delete role")
);

export default (app: Router) => app.use("/roles", router);
