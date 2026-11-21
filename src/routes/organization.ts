import { Router } from "express";
import * as organization from "../controllers/organization.js";
import * as referenceQuestions from "../controllers/referenceQuestions.js";
import * as usage from "../controllers/usage.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess, requireVerifiedEmail } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { avatarUpload } from "../middleware/multer.js";
import {
  accessCodeIpLimiter,
  accessCodeLimiter,
  peopleAiLimiter,
} from "../middleware/rateLimiter.js";
import { UserRole } from "../types/enums.js";
import {
  addDepartmentValidator,
  createOrganizationValidator,
  deleteOrganizationValidator,
  inviteTokenValidator,
  joinRequestIdValidator,
  joinWithAccessCodeValidator,
  joinRequestOrganizationValidator,
  organizationLogoValidator,
  removeDepartmentValidator,
  revokeOrganizationInviteValidator,
  sendOrganizationInviteValidator,
  switchOrganizationValidator,
  updateMemberValidator,
  updateOrganizationValidator,
} from "../validators/organization.js";
import {
  generateReferenceQuestionsValidator,
  organizationIdValidator,
  sendReferenceQuestionsValidator,
  setReferenceQuestionsValidator,
} from "../validators/referenceQuestions.js";

const router = Router();

router.post(
  "/",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(createOrganizationValidator),
  asyncHandler(organization.registerOrganization, "create company")
);

router.get(
  "/me",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  asyncHandler(organization.listMyOrganizations, "load your companies")
);

router.get(
  "/verified",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  asyncHandler(organization.listVerifiedOrganizations, "load verified companies")
);

router.post(
  "/access-code/join",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  accessCodeIpLimiter,
  accessCodeLimiter,
  validate(joinWithAccessCodeValidator),
  asyncHandler(organization.joinOrganizationWithAccessCode, "join with access code")
);

router.get(
  "/:_id/access-code",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(switchOrganizationValidator),
  asyncHandler(organization.getOrganizationAccessCode, "load access code")
);

router.post(
  "/:_id/access-code",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(switchOrganizationValidator),
  asyncHandler(organization.rotateOrganizationAccessCode, "create access code")
);

router.delete(
  "/:_id/access-code",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(switchOrganizationValidator),
  asyncHandler(organization.disableOrganizationAccessCode, "turn off access code")
);

router.get(
  "/invites/:token",
  validate(inviteTokenValidator),
  asyncHandler(organization.getOrganizationInvitePreview, "load invite")
);

router.post(
  "/invites/:token/accept",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(inviteTokenValidator),
  asyncHandler(organization.acceptOrganizationInvite, "accept invite")
);

router.post(
  "/:_id/invites",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(sendOrganizationInviteValidator),
  asyncHandler(organization.sendOrganizationInvite, "send invite")
);

router.get(
  "/:_id/members",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(switchOrganizationValidator),
  asyncHandler(organization.listOrganizationMembers, "load team members")
);

router.patch(
  "/:_id/members/:memberId",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(updateMemberValidator),
  asyncHandler(organization.updateMember, "update team member")
);

router.post(
  "/:_id/departments",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(addDepartmentValidator),
  asyncHandler(organization.addDepartment, "add department")
);

router.delete(
  "/:_id/departments/:name",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(removeDepartmentValidator),
  asyncHandler(organization.removeDepartment, "remove department")
);

router.get(
  "/:_id/reference-questions",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(organizationIdValidator),
  asyncHandler(referenceQuestions.list, "load reference questions")
);

router.put(
  "/:_id/reference-questions",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(setReferenceQuestionsValidator),
  asyncHandler(referenceQuestions.save, "save reference questions")
);

router.post(
  "/:_id/reference-questions/generate",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  peopleAiLimiter,
  validate(generateReferenceQuestionsValidator),
  asyncHandler(referenceQuestions.generate, "write reference questions")
);

router.get(
  "/:_id/reference-questions/jobs",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(organizationIdValidator),
  asyncHandler(referenceQuestions.jobs, "load jobs with waiting referees")
);

router.post(
  "/:_id/reference-questions/send",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(sendReferenceQuestionsValidator),
  asyncHandler(referenceQuestions.send, "send reference questions")
);

router.get(
  "/:_id/feed",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(switchOrganizationValidator),
  asyncHandler(organization.getFeedStatus, "load job feed")
);

router.get(
  "/:_id/usage",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(switchOrganizationValidator),
  asyncHandler(usage.getOrganizationUsage, "load plan usage")
);

router.get(
  "/:_id/plan-history",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(switchOrganizationValidator),
  asyncHandler(usage.getOrganizationPlanHistory, "load plan history")
);

router.get(
  "/:_id/invites",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(switchOrganizationValidator),
  asyncHandler(organization.listOrganizationInvites, "load invites")
);

router.delete(
  "/:_id/invites/:inviteId",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(revokeOrganizationInviteValidator),
  asyncHandler(organization.revokeOrganizationInvite, "revoke invite")
);

router.post(
  "/:_id/join-request",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(joinRequestOrganizationValidator),
  asyncHandler(organization.requestJoinOrganization, "request to join company")
);

router.get(
  "/:_id/join-requests",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(switchOrganizationValidator),
  asyncHandler(organization.listOrganizationJoinRequests, "load join requests")
);

router.patch(
  "/join-requests/:requestId/approve",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(joinRequestIdValidator),
  asyncHandler(organization.approveJoinRequest, "approve join request")
);

router.patch(
  "/join-requests/:requestId/reject",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(joinRequestIdValidator),
  asyncHandler(organization.rejectJoinRequest, "reject join request")
);

router.patch(
  "/:_id/switch",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(switchOrganizationValidator),
  asyncHandler(organization.switchOrganization, "switch company")
);

router.patch(
  "/:_id",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(updateOrganizationValidator),
  asyncHandler(organization.updateOrganization, "update company")
);

router.delete(
  "/:_id",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(deleteOrganizationValidator),
  asyncHandler(organization.deleteOrganization, "delete company")
);

router.patch(
  "/:_id/logo",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  avatarUpload.single("logo"),
  validate(organizationLogoValidator),
  asyncHandler(organization.updateLogo, "update company logo")
);

router.delete(
  "/:_id/logo",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(organizationLogoValidator),
  asyncHandler(organization.removeLogo, "remove company logo")
);

export default (app: Router) => app.use("/organizations", router);
