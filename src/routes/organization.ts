import { Router } from "express";
import * as organization from "../controllers/organization.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import { createOrganizationValidator, switchOrganizationValidator } from "../validators/organization.js";

const router = Router();

router.post(
  "/",
  validateAccess([UserRole.Recruiter]),
  validate(createOrganizationValidator),
  asyncHandler(organization.registerOrganization)
);

router.get(
  "/me",
  validateAccess([UserRole.Recruiter]),
  asyncHandler(organization.listMyOrganizations)
);

router.patch(
  "/:_id/switch",
  validateAccess([UserRole.Recruiter]),
  validate(switchOrganizationValidator),
  asyncHandler(organization.switchOrganization)
);

export default (app: Router) => app.use("/organizations", router);
