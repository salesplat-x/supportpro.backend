import { Router } from "express";

const router = Router();

import * as job from "../../controllers/v1/job";
import validate from "../../middlewares/v1/validators/validate";
import * as jobValidator from "../../middlewares/v1/validators/job";
import { asyncHandler } from "../../middlewares/v1/handler";
import { validateAccess } from "../../middlewares/v1/auth";
import { Roles } from "../../typings/customs";

router.post(
  "/",
  validateAccess([Roles.Recruiter]),
  validate(jobValidator.job, { body: true }),
  asyncHandler(job.create)
);

router.patch(
  "/:_id",
  validateAccess([Roles.Recruiter]),
  validate(jobValidator.updateJob, { params: true, body: true }),
  asyncHandler(job.update)
);

router.get(
  "/",
  validate(jobValidator.allJobs, { query: true }),
  asyncHandler(job.fetchAll)
);

// Endpoint to get talents based on CV and JD embedding similarity
router.get(
  "/talents/:jobId",
  validateAccess([Roles.Recruiter, Roles.Admin]),
  validate(jobValidator.topTalents, { params: true, query: true }),
  asyncHandler(job.topTalents)
);

// Endpoint to grade user CV
router.patch(
  "/cv-similarity/:jobId",
  validateAccess([Roles.Talent]),
  asyncHandler(job.gradeCv)
);

// Endpoint to get talents based on profile and Job similarity
router.get(
  "/match/:_id",
  validateAccess([Roles.Recruiter, Roles.Admin]),
  validate(jobValidator.matchJob, { params: true, query: true }),
  asyncHandler(job.matchJob)
);

// Endpoint to apply for a job
router.post(
  "/applications/:jobId",
  validateAccess([Roles.Talent]),
  validate(jobValidator.apply, { params: true }),
  asyncHandler(job.apply)
);

// Endpoint to get talents based on profile and Job similarity
router.get(
  "/applications/:jobId",
  validateAccess([Roles.Recruiter]),
  validate(jobValidator.getApplications, { params: true, query: true }),
  asyncHandler(job.applications)
);

router.get(
  "/:_id",
  validate(jobValidator.matchJob, { params: true }),
  asyncHandler(job.fetch)
);

export default (app: Router) => app.use("/jobs", router);
