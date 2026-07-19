import { Router } from "express";
import * as job from "../controllers/job.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess } from "../middleware/auth.js";
import { UserRole } from "../types/enums.js";
import {
  createJobValidator,
  updateJobValidator,
  allJobsQueryValidator,
  topTalentsValidator,
  matchJobValidator,
  applyValidator,
  jobApplicationsQueryValidator,
} from "../validators/job.js";

const router = Router();

router.post(
  "/",
  validateAccess([UserRole.Recruiter]),
  validate(createJobValidator),
  asyncHandler(job.create)
);
router.patch(
  "/:_id",
  validateAccess([UserRole.Recruiter]),
  validate(updateJobValidator),
  asyncHandler(job.update)
);
router.delete(
  "/:_id",
  validateAccess([UserRole.Recruiter]),
  validate(matchJobValidator),
  asyncHandler(job.remove)
);
router.get("/", validate(allJobsQueryValidator), asyncHandler(job.fetchAll));
router.get(
  "/me",
  validateAccess([UserRole.Recruiter]),
  validate(allJobsQueryValidator),
  asyncHandler(job.jobsPosted)
);
router.get(
  "/talents/:jobId",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  validate(topTalentsValidator),
  asyncHandler(job.topTalents)
);
router.patch("/cv-similarity/:jobId", validateAccess([UserRole.Talent]), asyncHandler(job.gradeCv));
router.get(
  "/match/:_id",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  validate(matchJobValidator),
  asyncHandler(job.matchJob)
);
router.patch(
  "/applications/:jobId",
  validateAccess([UserRole.Talent]),
  validate(applyValidator),
  asyncHandler(job.apply)
);
router.get(
  "/applications/:jobId",
  validateAccess([UserRole.Recruiter]),
  validate(jobApplicationsQueryValidator),
  asyncHandler(job.applications)
);
router.get("/:_id", validate(matchJobValidator), asyncHandler(job.fetch));

export default (app: Router) => app.use("/jobs", router);
