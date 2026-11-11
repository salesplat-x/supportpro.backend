import { Router } from "express";
import * as job from "../controllers/job.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { optionalAuth, requireVerifiedEmail, validateAccess } from "../middleware/auth.js";
import { UserRole } from "../types/enums.js";
import {
  salaryComparisonValidator,
  createJobValidator,
  updateJobValidator,
  allJobsQueryValidator,
  topTalentsValidator,
  matchJobValidator,
  applyValidator,
  jobApplicationsQueryValidator,
  retryVerdictsValidator,
  draftApplicantMessagesValidator,
  singleFitReportValidator,
  retryCvScoreValidator,
  bulkFitReportValidator,
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
  asyncHandler(job.generateContent, "generate job post")
);
router.post(
  "/generate/file",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  jobDescriptionUpload.single("file"),
  asyncHandler(job.generateContentFromFile, "generate job post from file")
);
router.post(
  "/generate/field",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(generateJobFieldValidator),
  asyncHandler(job.generateField, "generate this job post section")
);
router.post(
  "/",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(createJobValidator),
  asyncHandler(job.create, "create job")
);
router.get(
  "/salary-comparison",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(salaryComparisonValidator),
  asyncHandler(job.salaryComparison, "compare salaries")
);
router.patch(
  "/:_id",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(updateJobValidator),
  asyncHandler(job.update, "update job")
);
router.delete(
  "/:_id",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(matchJobValidator),
  asyncHandler(job.remove, "delete job")
);
router.get(
  "/",
  optionalAuth,
  validate(allJobsQueryValidator),
  asyncHandler(job.fetchAll, "load jobs")
);
router.get(
  "/me",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(allJobsQueryValidator),
  asyncHandler(job.jobsPosted, "load your jobs")
);
router.get(
  "/talents/:jobId",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(topTalentsValidator),
  asyncHandler(job.topTalents, "load top talents")
);
router.patch(
  "/prescreening-check/:jobId",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  validate(applyValidator),
  asyncHandler(job.checkPrescreening, "check pre-screening result")
);
router.get(
  "/match/:_id",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(matchJobValidator),
  asyncHandler(job.matchJob, "match talents to job")
);
router.patch(
  "/applications/:jobId",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  validate(applyValidator),
  asyncHandler(job.apply, "apply for job")
);
router.get(
  "/applications/:jobId",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(jobApplicationsQueryValidator),
  asyncHandler(job.applications, "load job applications")
);
router.post(
  "/:jobId/retry-verdicts",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(retryVerdictsValidator),
  asyncHandler(job.retryVerdicts, "retry AI matches")
);
router.post(
  "/:jobId/applications/:applicationId/cv-score",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(retryCvScoreValidator),
  asyncHandler(job.retryCvScore, "retry CV match score")
);
router.post(
  "/:jobId/applicants/messages/draft",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(draftApplicantMessagesValidator),
  asyncHandler(job.draftApplicantMessagesController, "draft applicant messages")
);
router.get(
  "/:jobId/applications/:applicationId/report",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(singleFitReportValidator),
  asyncHandler(job.singleFitReport, "load fit report")
);
router.post(
  "/:jobId/applications/report",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(bulkFitReportValidator),
  asyncHandler(job.bulkFitReport, "generate fit reports")
);
router.post(
  "/:jobId/activate-payment",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  asyncHandler(job.activatePayment, "start job payment")
);
router.get("/:_id", optionalAuth, validate(matchJobValidator), asyncHandler(job.fetch, "load job"));

export default (app: Router) => app.use("/jobs", router);
