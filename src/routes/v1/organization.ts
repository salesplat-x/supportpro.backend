import { Router } from "express";

const router = Router();

import * as org from "../../controllers/v1/organization";
import validate from "../../middlewares/v1/validators/validate";
import * as orgValidator from "../../middlewares/v1/validators/organization";
import { asyncHandler } from "../../middlewares/v1/handler";
import { validateAccess } from "../../middlewares/v1/auth";
import { Roles } from "../../typings/customs";

router.post(
  "/",
  validateAccess([Roles.Admin]),
  validate(orgValidator.organization, { body: true }),
  asyncHandler(org.registerOrganization)
);

// router.patch(
//   "/:_id",
//   validateAccess([Roles.Recruiter]),
//   validate(orgValidator.updateJob, { params: true, body: true }),
//   asyncHandler(org.update)
// );

// router.get(
//   "/",
//   validate(orgValidator.allJobs, { query: true }),
//   asyncHandler(org.fetchAll)
// );

export default (app: Router) => app.use("/organizations", router);
