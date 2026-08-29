import { Router } from "express";
import * as auth from "../controllers/auth.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired } from "../middleware/auth.js";
import { authLimiter, verificationLimiter } from "../middleware/rateLimiter.js";
import {
  registerValidator,
  loginValidator,
  emailOnlyValidator,
  resetPasswordValidator,
  changePasswordValidator,
  verifyEmailValidator,
  changeEmailValidator,
} from "../validators/auth.js";

const router = Router();

router.post("/register", validate(registerValidator), asyncHandler(auth.register));
router.post(
  "/register/recruiter",
  validate(registerValidator),
  asyncHandler(auth.registerRecruiter)
);
router.post("/login", authLimiter, validate(loginValidator), asyncHandler(auth.login));
router.post(
  "/forgot-password",
  authLimiter,
  validate(emailOnlyValidator),
  asyncHandler(auth.forgotPassword)
);
router.post(
  "/reset-password",
  authLimiter,
  validate(resetPasswordValidator),
  asyncHandler(auth.resetPassword)
);
router.post(
  "/change-password",
  loginRequired,
  validate(changePasswordValidator),
  asyncHandler(auth.changePassword)
);
router.post("/logout", loginRequired, asyncHandler(auth.logout));
router.post(
  "/verify-email",
  verificationLimiter,
  validate(verifyEmailValidator),
  asyncHandler(auth.verifyEmail)
);
router.post(
  "/resend-verification",
  loginRequired,
  verificationLimiter,
  asyncHandler(auth.resendVerification)
);
router.post(
  "/change-email",
  loginRequired,
  verificationLimiter,
  validate(changeEmailValidator),
  asyncHandler(auth.changeEmail)
);

export default (app: Router) => app.use("/auth", router);
