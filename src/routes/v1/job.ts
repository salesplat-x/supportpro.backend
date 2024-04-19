import { Router } from "express";

const router = Router();

import * as job from "../../controllers/v1/job";
import validate from "../../middlewares/v1/validators/validate";
import * as jobValidator from "../../middlewares/v1/validators/job";
import { asyncHandler } from "../../middlewares/v1/handler";

router.post(
  "/",
  // @TODO add role based access only recuiters can post jobs
  validate(jobValidator.job, { body: true }),
  asyncHandler(job.create)
);

export default (app: Router) => app.use("/jobs", router);
