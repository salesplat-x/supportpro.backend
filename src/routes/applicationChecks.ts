import { Router } from "express";
import { body, param } from "express-validator";
import * as consent from "../controllers/applicationConsent.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired, requireVerifiedEmail } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

const router = Router();

const applicationParams = [
  param("applicationId").isUUID().withMessage("applicationId must be a valid id"),
];

router.post(
  "/applications/:applicationId/consent",
  loginRequired,
  requireVerifiedEmail,
  validate([...applicationParams, body("version").isString().withMessage("version is required")]),
  asyncHandler(consent.agree, "agree to background checks")
);

router.get(
  "/applications/:applicationId/consent",
  loginRequired,
  requireVerifiedEmail,
  validate(applicationParams),
  asyncHandler(consent.readConsent, "read background checks consent")
);

export default (app: Router) => app.use("/checks", router);
