import { Router } from "express";
import * as user from "../controllers/user.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired, requireVerifiedEmail, validateAccess } from "../middleware/auth.js";
import { cvUpload, avatarUpload } from "../middleware/multer.js";
import { UserRole } from "../types/enums.js";
import {
  updateUserValidator,
  updateProfileValidator,
  userProfilesQueryValidator,
  userApplicationsQueryValidator,
  userIdParamValidator,
} from "../validators/user.js";

const router = Router();

router.patch(
  "/me",
  loginRequired,
  requireVerifiedEmail,
  validate(updateUserValidator),
  asyncHandler(user.updateUser, "update account")
);
// Distinct from /me: accepts a multipart cv file upload (parsed by extraction/embedding
// pipeline), so it stays separate rather than merging into /me.
router.patch(
  "/profile",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  cvUpload.single("cv"),
  validate(updateProfileValidator),
  asyncHandler(user.editProfile, "update profile")
);
// Every role can have an avatar, unlike the talent-only CV flow above, so this stays a
// separate route rather than being folded into /profile.
router.patch(
  "/avatar",
  loginRequired,
  requireVerifiedEmail,
  avatarUpload.single("avatar"),
  asyncHandler(user.updateAvatar, "update profile picture")
);
router.delete(
  "/avatar",
  loginRequired,
  requireVerifiedEmail,
  asyncHandler(user.removeAvatar, "remove profile picture")
);
router.get("/me", loginRequired, asyncHandler(user.me, "load your profile"));
// No email-verification gate: the tour runs on a new user's first dashboard visit,
// which can happen before they verify.
router.get("/me/onboarding", loginRequired, asyncHandler(user.myOnboarding, "load your onboarding"));
router.get(
  "/profile/",
  validateAccess([UserRole.Admin, UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(userProfilesQueryValidator),
  asyncHandler(user.viewProfiles, "load talent profiles")
);
router.get(
  "/profile/:_id/cv",
  validateAccess([UserRole.Admin, UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(userIdParamValidator),
  asyncHandler(user.downloadTalentCv, "download CV")
);
router.post(
  "/profile/:_id/reprocess-cv",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(userIdParamValidator),
  asyncHandler(user.reprocessCv, "reprocess CV")
);
router.get(
  "/profile/:_id",
  validateAccess([UserRole.Admin, UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(userIdParamValidator),
  asyncHandler(user.viewProfile, "load profile")
);
router.get(
  "/applications",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  validate(userApplicationsQueryValidator),
  asyncHandler(user.applications, "load your applications")
);

export default (app: Router) => app.use("/user", router);
