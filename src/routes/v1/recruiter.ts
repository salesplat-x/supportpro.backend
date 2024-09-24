import { Router } from "express";

import * as user from "../../controllers/v1/user";
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
  asyncHandler(user.recruiterDashboard)
);

export default (app: Router) => app.use("/recruiter", router);
