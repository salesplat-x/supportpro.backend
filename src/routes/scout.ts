import { Router } from "express";
import * as scout from "../controllers/scout.js";
import * as scoutJob from "../controllers/scoutJob.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess, requireVerifiedEmail } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { cvUpload } from "../middleware/multer.js";
import { scoutRunLimiter } from "../middleware/rateLimiter.js";
import { UserRole } from "../types/enums.js";
import { MAX_BATCH_SIZE } from "../config/scout.js";
import {
  searchTalentsValidator,
  scoutRunIdParamValidator,
  scoutIdParamValidator,
  scoutCandidateIdParamValidator,
  startScoutRunValidator,
  runsListQueryValidator,
  validateScoutCvFiles,
  addScoutToPipelineValidator,
  messageCandidateValidator,
} from "../validators/scout.js";
import {
  createScoutJobValidator,
  updateScoutJobValidator,
  scoutJobIdParamValidator,
  scoutJobsListQueryValidator,
} from "../validators/scoutJob.js";

const router = Router();

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------
router.get(
  "/jobs",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(scoutJobsListQueryValidator),
  asyncHandler(scoutJob.list)
);
router.post(
  "/jobs/",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(createScoutJobValidator),
  asyncHandler(scoutJob.create)
);

// Declared before `/jobs/:_id` so the literal segments can't be captured as an id.
router.post(
  "/jobs/:id/runs",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  scoutRunLimiter,
  cvUpload.fields([{ name: "cv", maxCount: MAX_BATCH_SIZE }]),
  validate(startScoutRunValidator),
  validateScoutCvFiles,
  asyncHandler(scout.startRun)
);
router.get(
  "/jobs/:id/runs",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(runsListQueryValidator),
  asyncHandler(scout.listRuns)
);

router.put(
  "/jobs/:_id",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(updateScoutJobValidator),
  asyncHandler(scoutJob.update)
);
router.get(
  "/jobs/:_id",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(scoutJobIdParamValidator),
  asyncHandler(scoutJob.fetch)
);
router.delete(
  "/jobs/:_id",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(scoutJobIdParamValidator),
  asyncHandler(scoutJob.remove)
);

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------
router.get(
  "/runs/:runId",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(scoutRunIdParamValidator),
  asyncHandler(scout.fetchRun)
);
router.get(
  "/runs/:runId/shortlist",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(scoutRunIdParamValidator),
  asyncHandler(scout.fetchShortlist)
);
router.get(
  "/runs/:runId/report.pdf",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(scoutRunIdParamValidator),
  asyncHandler(scout.downloadReport)
);

// ---------------------------------------------------------------------------
// Talent Search and the sourced-candidate pool
// ---------------------------------------------------------------------------
router.post(
  "/talents/search",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(searchTalentsValidator),
  asyncHandler(scout.searchTalents)
);
router.get(
  "/candidates/:candidateId/cv",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(scoutCandidateIdParamValidator),
  asyncHandler(scout.downloadCandidateCv)
);
router.post(
  "/candidates/:candidateId/message",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(messageCandidateValidator),
  asyncHandler(scout.messageCandidate)
);

// ---------------------------------------------------------------------------
// Individual CVs
// ---------------------------------------------------------------------------
router.post(
  "/cvs/:scoutId/retry",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(scoutIdParamValidator),
  asyncHandler(scout.retryCv)
);

// Last, so it can't shadow any of the literal prefixes above.
router.post(
  "/:scoutId/add-to-pipeline",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(addScoutToPipelineValidator),
  asyncHandler(scout.addScoutToPipeline)
);

export default (app: Router) => app.use("/scout", router);
