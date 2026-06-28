import { Router } from "express";
import * as user from "../controllers/user.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired, validateAccess, requireCompletedProfile } from "../middleware/auth.js";
import { memoryUpload } from "../middleware/multer.js";
import { UserRole } from "../types/enums.js";
import {
  updateUserValidator,
  updateProfileValidator,
  userProfilesQueryValidator,
  userApplicationsQueryValidator,
  userIdParamValidator,
} from "../validators/user.js";

const router = Router();

router.post(
  "/me/image",
  loginRequired,
  memoryUpload.single("image"),
  asyncHandler(user.uploadProfileImage)
);
router.patch("/me", loginRequired, validate(updateUserValidator), asyncHandler(user.updateUser));
router.patch(
  "/profile",
  validateAccess([UserRole.Talent]),
  memoryUpload.single("cv"),
  asyncHandler(user.editProfile)
);
router.get("/me", loginRequired, asyncHandler(user.me));
router.get(
  "/profile/",
  validateAccess([UserRole.Admin, UserRole.Recruiter]),
  validate(userProfilesQueryValidator),
  asyncHandler(user.viewProfiles)
);
router.get(
  "/profile/:_id",
  validateAccess([UserRole.Admin, UserRole.Recruiter]),
  validate(userIdParamValidator),
  asyncHandler(user.viewProfile)
);
router.get(
  "/applications",
  validateAccess([UserRole.Talent]),
  validate(userApplicationsQueryValidator),
  asyncHandler(user.applications)
);

export default (app: Router) => app.use("/user", router);
