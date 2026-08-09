import { Router } from "express";
import * as user from "../controllers/user.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired, validateAccess } from "../middleware/auth.js";
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

router.patch("/me", loginRequired, validate(updateUserValidator), asyncHandler(user.updateUser));
// Distinct from /me: accepts a multipart cv file upload (parsed by extraction/embedding
// pipeline), so it stays separate rather than merging into /me.
router.patch(
  "/profile",
  validateAccess([UserRole.Talent]),
  memoryUpload.single("cv"),
  validate(updateProfileValidator),
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
  "/profile/:_id/cv",
  validateAccess([UserRole.Admin, UserRole.Recruiter]),
  validate(userIdParamValidator),
  asyncHandler(user.downloadTalentCv)
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
