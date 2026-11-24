import { Router } from "express";
import * as admin from "../controllers/admin.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess, requireVerifiedEmail } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import {
  adminAiFeatureKeyValidator,
  adminChangeOwnerValidator,
  adminAiFeatureModelValidator,
  adminAiFeaturePromptsValidator,
  adminAiSkillValidator,
  adminApplicationFollowUpEmailValidator,
  adminOverviewQueryValidator,
  adminApplicationIdParamValidator,
  adminIdParamValidator,
  adminJobsQueryValidator,
  adminOnboardingEmailValidator,
  adminUserIdParamValidator,
  adminOrganizationsQueryValidator,
  adminRecruitersQueryValidator,
  adminStuckApplicationsQueryValidator,
  adminTalentsQueryValidator,
} from "../validators/admin.js";

const router = Router();

router.get(
  "/overview",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminOverviewQueryValidator),
  asyncHandler(admin.overview, "load overview")
);

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
router.get(
  "/users/:_id/stuck-applications",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminUserIdParamValidator),
  asyncHandler(admin.talentStuckApplications, "load talent's stuck applications")
);

router.get(
  "/applications",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminStuckApplicationsQueryValidator),
  asyncHandler(admin.listStuckApplications, "load stuck applications")
);
router.get(
  "/applications/:_id/follow-up",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminApplicationIdParamValidator),
  asyncHandler(admin.applicationFollowUp, "load application follow-up")
);
router.post(
  "/applications/:_id/follow-up/draft",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminApplicationIdParamValidator),
  asyncHandler(admin.draftApplicationFollowUpEmail, "draft application follow-up email")
);
router.post(
  "/applications/:_id/follow-up/emails",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminApplicationFollowUpEmailValidator),
  asyncHandler(admin.sendApplicationFollowUpEmail, "send application follow-up email")
);

router.patch(
  "/organizations/:_id/owner",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminChangeOwnerValidator),
  asyncHandler(admin.changeOrganizationOwner, "change company creator")
);

router.get(
  "/ai-models",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  asyncHandler(admin.getAiModels, "load AI models")
);
router.patch(
  "/ai-models/features/:key",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminAiFeatureModelValidator),
  asyncHandler(admin.updateAiFeatureModel, "update AI model")
);

router.get(
  "/ai-models/features/:key/prompts",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminAiFeatureKeyValidator),
  asyncHandler(admin.getAiFeaturePrompts, "load AI prompts")
);
router.put(
  "/ai-models/features/:key/prompts",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminAiFeaturePromptsValidator),
  asyncHandler(admin.updateAiFeaturePrompts, "save AI prompts")
);

router.get(
  "/ai-models/skills",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  asyncHandler(admin.getAiSkills, "load AI skills")
);
router.put(
  "/ai-models/skills/:key",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(adminAiSkillValidator),
  asyncHandler(admin.updateAiSkill, "save AI skill")
);

export default (app: Router) => app.use("/admin", router);
