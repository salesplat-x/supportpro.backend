import { Router } from "express";

const router = Router();

import * as application from "../../controllers/v1/application";
import validate from "../../middlewares/v1/validators/validate";
import * as applicationValidator from "../../middlewares/v1/validators/application";
import { asyncHandler } from "../../middlewares/v1/handler";
import { loginRequired, validateAccess } from "../../middlewares/v1/auth";
import { Roles } from "../../typings/customs";

router.get(
  "/",
  validateAccess([Roles.Recruiter]),
  validate(applicationValidator.getApplications, { query: true }),
  asyncHandler(application.getApplications)
);

router.get(
  "/:_id",
  loginRequired,
  validate(applicationValidator.getApplication, { params: true }),
  asyncHandler(application.getApplication)
);

router.patch(
  "/:_id/status",
  validateAccess([Roles.Recruiter]),
  validate(applicationValidator.updateApplicationStatus, {
    params: true,
    body: true,
  }),
  asyncHandler(application.updateStatus)
);

export default (app: Router) => app.use("/applications", router);
