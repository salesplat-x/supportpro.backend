import { Router } from "express";

const router = Router();

import * as role from "../../controllers/v1/role";
import validate from "../../middlewares/v1/validators/validate";
import * as roleValidator from "../../middlewares/v1/validators/role";
import { asyncHandler } from "../../middlewares/v1/handler";
import { validateAccess } from "../../middlewares/v1/auth";
import { Roles } from "../../typings/customs";

router.post(
  "/",
  validateAccess([Roles.Recruiter, Roles.Admin]),
  validate(roleValidator.role, { body: true }),
  asyncHandler(role.create)
);

router.get(
  "/",
  validate(roleValidator.allRoles, { query: true }),
  asyncHandler(role.fetchAll)
);

router.get(
  "/:_id",
  validate(roleValidator.roleId, { params: true }),
  asyncHandler(role.fetch)
);

router.get(
  "/:_id/questions",
  validate(roleValidator.roleQuestions, { params: true, query: true }),
  asyncHandler(role.questions)
);

export default (app: Router) => app.use("/roles", router);
