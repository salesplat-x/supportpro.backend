import { Router } from "express";
import * as job from "../controllers/job.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { optionalAuth, requireVerifiedEmail, validateAccess } from "../middleware/auth.js";
import { UserRole } from "../types/enums.js";
import {
  createJobValidator,
  updateJobValidator,
  allJobsQueryValidator,
  topTalentsValidator,
  matchJobValidator,
  applyValidator,
  jobApplicationsQueryValidator,
  generateJobContentValidator,
  generateJobFieldValidator,
} from "../validators/job.js";
import { jobDescriptionUpload } from "../middleware/multer.js";

const router = Router();

router.post(
  "/generate",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(generateJobContentValidator),
  asyncHandler(job.generateContent)
);
router.post(
  "/generate/file",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  jobDescriptionUpload.single("file"),
  asyncHandler(job.generateContentFromFile)
);
router.post(
  "/generate/field",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(generateJobFieldValidator),
  asyncHandler(job.generateField)
);
router.post(
  "/",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(createJobValidator),
  asyncHandler(job.create)
);
router.patch(
  "/:_id",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(updateJobValidator),
  asyncHandler(job.update)
);
router.delete(
  "/:_id",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(matchJobValidator),
  asyncHandler(job.remove)
);
router.get("/", optionalAuth, validate(allJobsQueryValidator), asyncHandler(job.fetchAll));
router.get(
  "/me",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(allJobsQueryValidator),
  asyncHandler(job.jobsPosted)
);
router.get(
  "/talents/:jobId",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(topTalentsValidator),
  asyncHandler(job.topTalents)
);
router.patch(
  "/cv-similarity/:jobId",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  asyncHandler(job.gradeCv)
);
router.patch(
  "/prescreening-check/:jobId",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  validate(applyValidator),
  asyncHandler(job.checkPrescreening)
);
router.get(
  "/match/:_id",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(matchJobValidator),
  asyncHandler(job.matchJob)
);
router.patch(
  "/applications/:jobId",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  validate(applyValidator),
  asyncHandler(job.apply)
);
router.get(
  "/applications/:jobId",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(jobApplicationsQueryValidator),
  asyncHandler(job.applications)
);
router.post(
  "/:jobId/retry-verdicts",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  asyncHandler(job.retryVerdicts)
);
router.post(
  "/:jobId/activate-payment",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  asyncHandler(job.activatePayment)
);
router.get("/:_id", optionalAuth, validate(matchJobValidator), asyncHandler(job.fetch));

export default (app: Router) => app.use("/jobs", router);
