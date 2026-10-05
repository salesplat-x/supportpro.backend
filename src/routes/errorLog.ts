import { Router } from "express";
import * as errorLog from "../controllers/errorLog.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess, requireVerifiedEmail } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import {
  getErrorLogsQueryValidator,
  resolveErrorLogValidator,
  cleanupLogsValidator,
} from "../validators/errorLog.js";

const router = Router();

router.get(
  "/",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(getErrorLogsQueryValidator),
  asyncHandler(errorLog.getErrorLogs, "load error logs")
);
router.get(
  "/stats",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  asyncHandler(errorLog.getErrorStats, "load error statistics")
);
router.patch(
  "/:requestId/resolve",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(resolveErrorLogValidator),
  asyncHandler(errorLog.markErrorAsResolved, "mark error as resolved")
);
router.delete(
  "/cleanup",
  validateAccess([UserRole.Admin]),
  requireVerifiedEmail,
  validate(cleanupLogsValidator),
  asyncHandler(errorLog.cleanupOldLogs, "clean up old error logs")
);

export default (app: Router) => app.use("/error-logs", router);
