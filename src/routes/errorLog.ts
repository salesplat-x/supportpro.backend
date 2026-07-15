import { Router } from "express";
import * as errorLog from "../controllers/errorLog.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess } from "../middleware/auth.js";
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
  validate(getErrorLogsQueryValidator),
  asyncHandler(errorLog.getErrorLogs)
);
router.get("/stats", validateAccess([UserRole.Admin]), asyncHandler(errorLog.getErrorStats));
router.patch(
  "/:requestId/resolve",
  validateAccess([UserRole.Admin]),
  validate(resolveErrorLogValidator),
  asyncHandler(errorLog.markErrorAsResolved)
);
router.delete(
  "/cleanup",
  validateAccess([UserRole.Admin]),
  validate(cleanupLogsValidator),
  asyncHandler(errorLog.cleanupOldLogs)
);

export default (app: Router) => app.use("/error-logs", router);
