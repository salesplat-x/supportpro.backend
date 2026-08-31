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
} from "../validators/application.js";

const router = Router();

router.get(
  "/",
  loginRequired,
  requireVerifiedEmail,
  validate(getApplicationsQueryValidator),
  asyncHandler(application.getApplications)
);
router.get(
  "/:_id",
  loginRequired,
  requireVerifiedEmail,
  validate(applicationIdParamValidator),
  asyncHandler(application.getApplication)
);
router.patch(
  "/status",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(bulkUpdateApplicationStatusValidator),
  asyncHandler(application.bulkUpdateStatus)
);
router.patch(
  "/:_id/status",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(updateApplicationStatusValidator),
  asyncHandler(application.updateStatus)
);

export default (app: Router) => app.use("/applications", router);
