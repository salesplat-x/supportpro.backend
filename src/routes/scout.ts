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
  validateCvAndCoverLetter,
  validateCv,
} from "../validators/scout.js";
import {
  createScoutJobValidator,
  updateScoutJobValidator,
  scoutJobIdParamValidator,
} from "../validators/scoutJob.js";

const router = Router();

// Scout job routes
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
  validateAccess([UserRole.Recruiter]),
  validate(scoutJobIdParamValidator),
  asyncHandler(scoutJob.fetch)
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
  "/cv-and-cover-letter",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  memoryUpload.fields([
    { name: "cv", maxCount: 1 },
    { name: "coverLetter", maxCount: 1 },
  ]),
  validateCvAndCoverLetter,
  asyncHandler(scout.scoutCvAndCl)
);
router.post(
  "/cv",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  memoryUpload.single("cv"),
  validateCv,
  asyncHandler(scout.scoutCv)
);

export default (app: Router) => app.use("/scout", router);
