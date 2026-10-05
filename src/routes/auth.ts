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
  resetTokenValidator,
  resetPasswordValidator,
  changePasswordValidator,
  verifyEmailValidator,
  changeEmailValidator,
  resendVerificationValidator,
} from "../validators/auth.js";

const router = Router();

router.post(
  "/register",
  validate(registerValidator),
  asyncHandler(auth.register, "create account")
);
router.post(
  "/register/recruiter",
  validate(registerValidator),
  asyncHandler(auth.registerRecruiter, "create recruiter account")
);
router.post("/login", authLimiter, validate(loginValidator), asyncHandler(auth.login, "sign in"));
router.post(
  "/forgot-password",
  authLimiter,
  validate(emailOnlyValidator),
  asyncHandler(auth.forgotPassword, "send password reset email")
);
router.post(
  "/validate-reset-token",
  authLimiter,
  validate(resetTokenValidator),
  asyncHandler(auth.validateResetToken, "check password reset link")
);
router.post(
  "/reset-password",
  authLimiter,
  validate(resetPasswordValidator),
  asyncHandler(auth.resetPassword, "reset password")
);
router.post(
  "/change-password",
  loginRequired,
  validate(changePasswordValidator),
  asyncHandler(auth.changePassword, "change password")
);
router.post("/logout", loginRequired, asyncHandler(auth.logout, "sign out"));
router.post(
  "/verify-email",
  verificationLimiter,
  validate(verifyEmailValidator),
  asyncHandler(auth.verifyEmail, "verify email")
);
router.post(
  "/resend-verification",
  loginRequired,
  verificationLimiter,
  validate(resendVerificationValidator),
  asyncHandler(auth.resendVerification, "resend verification email")
);
router.post(
  "/change-email",
  loginRequired,
  verificationLimiter,
  validate(changeEmailValidator),
  asyncHandler(auth.changeEmail, "change email")
);

export default (app: Router) => app.use("/auth", router);
