import { Router } from "express";
import { body, param } from "express-validator";
import * as applicationChecks from "../controllers/applicationChecks.js";
import * as consent from "../controllers/applicationConsent.js";
import { ID_KINDS } from "../services/checkConsent.js";
import { CHECK_RESULTS, CHECK_TYPES } from "../types/checks.js";
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

const checkParams = [param("checkId").isUUID().withMessage("checkId must be a valid id")];

const todayPlusOneDay = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

const resultBody = [
  body("confirmedOn")
    .isISO8601({ strict: true })
    .withMessage("confirmedOn must be a date like 2026-11-05")
    .bail()
    .custom((value: string) => value.slice(0, 10) <= todayPlusOneDay())
    .withMessage("confirmedOn cannot be in the future"),
  body("note").optional().isString().trim().isLength({ max: 2000 }),
  body("confirmedBy")
    .if(body("nameOnId").not().exists())
    .isString()
    .trim()
    .isLength({ min: 1, max: 160 })
    .withMessage("confirmedBy is required"),
  body("result")
    .if(body("nameOnId").not().exists())
    .isIn([...CHECK_RESULTS])
    .withMessage("result must be verified, flagged or failed"),
  body("nameOnId").optional().isString().trim().isLength({ min: 1, max: 200 }),
];

router.patch(
  "/:checkId/result",
  loginRequired,
  requireVerifiedEmail,
  validate([...checkParams, ...resultBody]),
  asyncHandler(applicationChecks.saveResult, "save a check result")
);

router.get(
  "/:checkId/history",
  loginRequired,
  requireVerifiedEmail,
  validate(checkParams),
  asyncHandler(applicationChecks.history, "read a check history")
);

router.get(
  "/:checkId/id-number",
  loginRequired,
  requireVerifiedEmail,
  validate(checkParams),
  asyncHandler(applicationChecks.idNumber, "read an ID number")
);

export default (app: Router) => app.use("/checks", router);
