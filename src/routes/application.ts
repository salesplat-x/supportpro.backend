import { Router } from "express";
import * as application from "../controllers/application.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired, requireVerifiedEmail, validateAccess } from "../middleware/auth.js";
import { UserRole } from "../types/enums.js";
import {
  getApplicationsQueryValidator,
  applicationIdParamValidator,
  updateApplicationStatusValidator,
  bulkUpdateApplicationStatusValidator,
  advanceApplicationValidator,
} from "../validators/application.js";

const router = Router();

router.get(
  "/",
  loginRequired,
  requireVerifiedEmail,
  validate(getApplicationsQueryValidator),
  asyncHandler(application.getApplications, "load applications")
);
router.get(
  "/:_id",
  loginRequired,
  requireVerifiedEmail,
  validate(applicationIdParamValidator),
  asyncHandler(application.getApplication, "load application")
);
router.patch(
  "/status",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(bulkUpdateApplicationStatusValidator),
  asyncHandler(application.bulkUpdateStatus, "update application statuses")
);
router.patch(
  "/:_id/status",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(updateApplicationStatusValidator),
  asyncHandler(application.updateStatus, "update application status")
);
router.post(
  "/:_id/advance",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(advanceApplicationValidator),
  asyncHandler(application.advance, "move candidate forward")
);
router.post(
  "/:_id/personality-fit",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(applicationIdParamValidator),
  asyncHandler(application.retryPersonalityFit, "work out personality fit")
);

export default (app: Router) => app.use("/applications", router);
