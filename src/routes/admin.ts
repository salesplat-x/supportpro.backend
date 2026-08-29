import { Router } from "express";
import * as admin from "../controllers/admin.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess, requireVerifiedEmail } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import {
  adminIdParamValidator,
  adminJobsQueryValidator,
  adminOrganizationsQueryValidator,
  adminRecruitersQueryValidator,
  adminTalentsQueryValidator,
} from "../validators/admin.js";

const router = Router();

router.get(
  "/talents",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminTalentsQueryValidator),
  asyncHandler(admin.listTalents)
);
router.delete(
  "/talents/:_id",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminIdParamValidator),
  asyncHandler(admin.deleteTalent)
);

router.get(
  "/recruiters",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminRecruitersQueryValidator),
  asyncHandler(admin.listRecruiters)
);
router.delete(
  "/recruiters/:_id",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminIdParamValidator),
  asyncHandler(admin.deleteRecruiter)
);

router.get(
  "/jobs",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminJobsQueryValidator),
  asyncHandler(admin.listJobs)
);
router.delete(
  "/jobs/:_id",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminIdParamValidator),
  asyncHandler(admin.deleteJob)
);

router.get(
  "/organizations",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminOrganizationsQueryValidator),
  asyncHandler(admin.listOrganizations)
);
router.get(
  "/organizations/:_id",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminIdParamValidator),
  asyncHandler(admin.getOrganization)
);
router.patch(
  "/organizations/:_id/verify",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminIdParamValidator),
  asyncHandler(admin.verifyOrganization)
);
router.patch(
  "/organizations/:_id/reject",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminIdParamValidator),
  asyncHandler(admin.rejectOrganization)
);

export default (app: Router) => app.use("/admin", router);
