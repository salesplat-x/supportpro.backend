import { Router } from "express";
import * as scout from "../controllers/scout.js";
import * as scoutJob from "../controllers/scoutJob.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { memoryUpload } from "../middleware/multer.js";
import { UserRole } from "../types/enums.js";
import {
  scoutTalentsValidator,
  scoutBatchIdParamValidator,
  scoutJobScoutsParamValidator,
  scoutCvBatchValidator,
  validateScoutCvBatchFiles,
  MAX_BATCH_SIZE,
} from "../validators/scout.js";
import {
  createScoutJobValidator,
  updateScoutJobValidator,
  scoutJobIdParamValidator,
  scoutJobsListQueryValidator,
} from "../validators/scoutJob.js";

const router = Router();

// Scout job routes
router.get(
  "/jobs",
  validateAccess([UserRole.Recruiter]),
  validate(scoutJobsListQueryValidator),
  asyncHandler(scoutJob.list)
);
router.post(
  "/jobs/",
  validateAccess([UserRole.Recruiter]),
  validate(createScoutJobValidator),
  asyncHandler(scoutJob.create)
);
router.put(
  "/jobs/:_id",
  validateAccess([UserRole.Recruiter]),
  validate(updateScoutJobValidator),
  asyncHandler(scoutJob.update)
);
router.get(
  "/jobs/:_id",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  validate(scoutJobIdParamValidator),
  asyncHandler(scoutJob.fetch)
);
router.delete(
  "/jobs/:_id",
  validateAccess([UserRole.Recruiter]),
  validate(scoutJobIdParamValidator),
  asyncHandler(scoutJob.remove)
);
router.get(
  "/jobs/:id/scouts",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  validate(scoutJobScoutsParamValidator),
  asyncHandler(scout.fetchScoutReportsByJob)
);

// Scout talent routes
router.get(
  "/:scoutJobId/talents",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  validate(scoutTalentsValidator),
  asyncHandler(scout.scoutTalents)
);
router.get(
  "/batch/:id",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  validate(scoutBatchIdParamValidator),
  asyncHandler(scout.fetchScoutReports)
);
router.get(
  "/single/:id",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  validate(scoutBatchIdParamValidator),
  asyncHandler(scout.fetchScoutReport)
);
router.post(
  "/cv-batch",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  memoryUpload.fields([
    { name: "cv", maxCount: MAX_BATCH_SIZE },
    { name: "coverLetter", maxCount: MAX_BATCH_SIZE },
  ]),
  validate(scoutCvBatchValidator),
  validateScoutCvBatchFiles,
  asyncHandler(scout.scoutCvBatch)
);

export default (app: Router) => app.use("/scout", router);
