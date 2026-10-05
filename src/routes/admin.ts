import { Router } from "express";
import * as admin from "../controllers/admin.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess, requireVerifiedEmail } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import {
  adminIdParamValidator,
  adminJobsQueryValidator,
  adminOnboardingEmailValidator,
  adminUserIdParamValidator,
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
  asyncHandler(admin.listTalents, "load talents")
);
router.delete(
  "/talents/:_id",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminIdParamValidator),
  asyncHandler(admin.deleteTalent, "delete talent")
);

router.get(
  "/recruiters",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminRecruitersQueryValidator),
  asyncHandler(admin.listRecruiters, "load recruiters")
);
router.delete(
  "/recruiters/:_id",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminIdParamValidator),
  asyncHandler(admin.deleteRecruiter, "delete recruiter")
);

router.get(
  "/jobs",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminJobsQueryValidator),
  asyncHandler(admin.listJobs, "load jobs")
);
router.delete(
  "/jobs/:_id",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminIdParamValidator),
  asyncHandler(admin.deleteJob, "delete job")
);

router.get(
  "/organizations",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminOrganizationsQueryValidator),
  asyncHandler(admin.listOrganizations, "load companies")
);
router.get(
  "/organizations/:_id",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminIdParamValidator),
  asyncHandler(admin.getOrganization, "load company")
);
router.patch(
  "/organizations/:_id/verify",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminIdParamValidator),
  asyncHandler(admin.verifyOrganization, "verify company")
);
router.patch(
  "/organizations/:_id/reject",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminIdParamValidator),
  asyncHandler(admin.rejectOrganization, "reject company")
);
router.delete(
  "/organizations/:_id",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminIdParamValidator),
  asyncHandler(admin.deleteOrganization, "delete company")
);

router.get(
  "/users/:_id/onboarding",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminUserIdParamValidator),
  asyncHandler(admin.userOnboarding, "load onboarding progress")
);
router.post(
  "/users/:_id/onboarding/draft",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminUserIdParamValidator),
  asyncHandler(admin.draftOnboardingEmail, "draft onboarding email")
);
router.post(
  "/users/:_id/onboarding/emails",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminOnboardingEmailValidator),
  asyncHandler(admin.sendOnboardingEmail, "send onboarding email")
);

export default (app: Router) => app.use("/admin", router);
