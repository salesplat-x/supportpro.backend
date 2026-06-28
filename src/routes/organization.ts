import { Router } from "express";
import * as organization from "../controllers/organization.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import { createOrganizationValidator } from "../validators/organization.js";

const router = Router();

router.post(
  "/",
  validateAccess([UserRole.Admin]),
  validate(createOrganizationValidator),
  asyncHandler(organization.registerOrganization)
);

export default (app: Router) => app.use("/organizations", router);
