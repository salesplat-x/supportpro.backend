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

router.get(
  "/",
  validate(jobValidator.allJobs, { query: true }),
  asyncHandler(job.fetchAll)
);

router.get(
  "/:_id",
  validate(jobValidator.jobId, { params: true }),
  asyncHandler(job.fetch)
);

export default (app: Router) => app.use("/jobs", router);
