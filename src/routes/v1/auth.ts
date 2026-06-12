import { Router } from "express";

const router = Router();

import * as auth from "../../controllers/v1/auth";
import validate from "../../middlewares/v1/validators/validate";
import * as authValidator from "../../middlewares/v1/validators/auth";
import { asyncHandler } from "../../middlewares/v1/handler";
import { loginRequired } from "../../middlewares/v1/auth";

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

router.post("/login", validate(authValidator.login, { body: true }), asyncHandler(auth.login));

router.post(
  "/forgot-password",
  validate(authValidator.emailOnly, { body: true }),
  asyncHandler(auth.forgotPassword)
);

router.post(
  "/reset-password",
  validate(authValidator.resetPassword, { body: true }),
  asyncHandler(auth.resetPassword)
);

router.post(
  "/change-password",
  loginRequired,
  validate(authValidator.changePassword, { body: true }),
  asyncHandler(auth.changePassword)
);

export default (app: Router) => app.use("/auth", router);
