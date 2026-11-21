import { Router } from "express";
import { body, param } from "express-validator";
import * as applicationChecks from "../controllers/applicationChecks.js";
import * as consent from "../controllers/applicationConsent.js";
import { ID_KINDS } from "../services/checkConsent.js";
import { CHECK_TYPES } from "../types/checks.js";
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
  validate([
    ...applicationParams,
    body("version").isString().withMessage("version is required"),
    body("idKind")
      .isIn([...ID_KINDS])
      .withMessage("idKind must be nin or bvn"),
    body("idNumber")
      .isString()
      .matches(/^\d{11}$/)
      .withMessage("The NIN or BVN must be exactly 11 digits"),
  ]),
  asyncHandler(consent.agree, "agree to background checks")
);

router.post(
  "/applications/:applicationId/consent/decline",
  loginRequired,
  requireVerifiedEmail,
  validate(applicationParams),
  asyncHandler(consent.decline, "decline background checks")
);

router.post(
  "/applications/:applicationId/consent/request",
  loginRequired,
  requireVerifiedEmail,
  validate(applicationParams),
  asyncHandler(consent.requestConsent, "ask for background checks consent")
);

router.get(
  "/applications/:applicationId/consent/mine",
  loginRequired,
  requireVerifiedEmail,
  validate(applicationParams),
  asyncHandler(consent.readMine, "read my background checks consent")
);

router.get(
  "/applications/:applicationId/consent",
  loginRequired,
  requireVerifiedEmail,
  validate(applicationParams),
  asyncHandler(consent.readConsent, "read background checks consent")
);

router.post(
  "/applications/:applicationId",
  loginRequired,
  requireVerifiedEmail,
  validate([
    ...applicationParams,
    body("type")
      .isIn(CHECK_TYPES)
      .withMessage("type must be one of identity, employment, education, criminal"),
  ]),
  asyncHandler(applicationChecks.orderCheck, "order a background check")
);

router.get(
  "/applications/:applicationId",
  loginRequired,
  requireVerifiedEmail,
  validate(applicationParams),
  asyncHandler(applicationChecks.listChecks, "list background checks")
);

export default (app: Router) => app.use("/checks", router);
