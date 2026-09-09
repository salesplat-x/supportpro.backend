import { Router } from "express";
import * as organization from "../controllers/organization.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess, requireVerifiedEmail } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import {
  createOrganizationValidator,
  deleteOrganizationValidator,
  inviteTokenValidator,
  joinRequestIdValidator,
  joinRequestOrganizationValidator,
  revokeOrganizationInviteValidator,
  sendOrganizationInviteValidator,
  switchOrganizationValidator,
  updateOrganizationValidator,
} from "../validators/organization.js";

const router = Router();

router.post(
  "/",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(createOrganizationValidator),
  asyncHandler(organization.registerOrganization)
);

router.get(
  "/me",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  asyncHandler(organization.listMyOrganizations)
);

router.get(
  "/verified",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  asyncHandler(organization.listVerifiedOrganizations)
);

router.get(
  "/invites/:token",
  validate(inviteTokenValidator),
  asyncHandler(organization.getOrganizationInvitePreview)
);

router.post(
  "/invites/:token/accept",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(inviteTokenValidator),
  asyncHandler(organization.acceptOrganizationInvite)
);

router.post(
  "/:_id/invites",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(sendOrganizationInviteValidator),
  asyncHandler(organization.sendOrganizationInvite)
);

router.get(
  "/:_id/invites",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(switchOrganizationValidator),
  asyncHandler(organization.listOrganizationInvites)
);

router.delete(
  "/:_id/invites/:inviteId",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(revokeOrganizationInviteValidator),
  asyncHandler(organization.revokeOrganizationInvite)
);

router.post(
  "/:_id/join-request",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(joinRequestOrganizationValidator),
  asyncHandler(organization.requestJoinOrganization)
);

router.get(
  "/:_id/join-requests",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(switchOrganizationValidator),
  asyncHandler(organization.listOrganizationJoinRequests)
);

router.patch(
  "/join-requests/:requestId/approve",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(joinRequestIdValidator),
  asyncHandler(organization.approveJoinRequest)
);

router.patch(
  "/join-requests/:requestId/reject",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(joinRequestIdValidator),
  asyncHandler(organization.rejectJoinRequest)
);

router.patch(
  "/:_id/switch",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(switchOrganizationValidator),
  asyncHandler(organization.switchOrganization)
);

router.patch(
  "/:_id",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(updateOrganizationValidator),
  asyncHandler(organization.updateOrganization)
);

router.delete(
  "/:_id",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(deleteOrganizationValidator),
  asyncHandler(organization.deleteOrganization)
);

export default (app: Router) => app.use("/organizations", router);
