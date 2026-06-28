import { Router } from "express";
import * as role from "../controllers/role.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess } from "../middleware/auth.js";
import { UserRole } from "../types/enums.js";
import {
  createRoleValidator,
  roleIdParamValidator,
  allRolesQueryValidator,
  roleQuestionsValidator,
} from "../validators/role.js";

const router = Router();

router.post(
  "/",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  validate(createRoleValidator),
  asyncHandler(role.create)
);
router.get("/", validate(allRolesQueryValidator), asyncHandler(role.fetchAll));
router.get("/:_id/questions", validate(roleQuestionsValidator), asyncHandler(role.questions));
router.get("/:_id", validate(roleIdParamValidator), asyncHandler(role.fetch));

export default (app: Router) => app.use("/roles", router);
