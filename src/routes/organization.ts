import { Router } from "express";
import * as organization from "../controllers/organization.js";
import * as usage from "../controllers/usage.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess, requireVerifiedEmail } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { avatarUpload } from "../middleware/multer.js";
import { UserRole } from "../types/enums.js";
import {
  createOrganizationValidator,
  deleteOrganizationValidator,
  inviteTokenValidator,
  joinRequestIdValidator,
  joinRequestOrganizationValidator,
  organizationLogoValidator,
  revokeOrganizationInviteValidator,
  sendOrganizationInviteValidator,
  setMemberCanManagePeopleValidator,
  switchOrganizationValidator,
  updateOrganizationValidator,
} from "../validators/organization.js";

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
  validate(setMemberCanManagePeopleValidator),
  asyncHandler(organization.setMemberCanManagePeople, "update team member")
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
