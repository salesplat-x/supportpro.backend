import { Router } from "express";

import * as recruiter from "../../controllers/v1/recruiter";
import * as application from "../../controllers/v1/application";
import validate from "../../middlewares/v1/validators/validate";
import * as applicationValidator from "../../middlewares/v1/validators/application";
import { asyncHandler } from "../../middlewares/v1/handler";
import { loginRequired, validateAccess } from "../../middlewares/v1/auth";
import { Roles } from "../../typings/customs";

const router = Router();

router.get(
  "/shortlist",
  validateAccess([Roles.Recruiter]),
  validate(applicationValidator.getApplications, { query: true }),
  asyncHandler(application.shortlist)
);

router.get(
  "/dashboard",
  validateAccess([Roles.Recruiter]),
  asyncHandler(recruiter.recruiterDashboard)
);

router.get(
  "/applications",
  validateAccess([Roles.Recruiter]),
  asyncHandler(recruiter.recentApplications)
);

router.get(
  "/compilations",
  validateAccess([Roles.Recruiter]),
  asyncHandler(recruiter.recentCompilations)
);

export default (app: Router) => app.use("/recruiter", router);
