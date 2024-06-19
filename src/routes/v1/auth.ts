import { Router } from "express";

const router = Router();

import * as auth from "../../controllers/v1/auth";
import validate from "../../middlewares/v1/validators/validate";
import * as authValidator from "../../middlewares/v1/validators/auth";
import { asyncHandler } from "../../middlewares/v1/handler";

router.post(
  "/register",
  validate(authValidator.register, { body: true }),
  asyncHandler(auth.register)
);

router.post(
  "/register/recruiter",
  validate(authValidator.register, { body: true }),
  asyncHandler(auth.registerRecruiter)
);

router.post(
  "/register/organization",
  validate(authValidator.organization, { body: true }),
  asyncHandler(auth.registerOrganization)
);

router.post(
  "/login",
  validate(authValidator.login, { body: true }),
  asyncHandler(auth.login)
);

export default (app: Router) => app.use("/auth", router);
