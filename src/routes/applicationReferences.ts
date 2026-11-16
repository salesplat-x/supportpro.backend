import { Router } from "express";
import { body, param } from "express-validator";
import * as references from "../controllers/applicationReferences.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired, requireVerifiedEmail } from "../middleware/auth.js";
import { documentLinkLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import * as referenceLink from "../controllers/referenceLink.js";

const router = Router();

const applicationParams = [
  param("applicationId").isUUID().withMessage("applicationId must be a valid id"),
];

const refereeBody = [
  body("name").isString().trim().isLength({ min: 1, max: 120 }).withMessage("name is required"),
  body("email").isString().trim().isEmail().withMessage("a valid email is required"),
  body("relationship")
    .isString()
    .trim()
    .isLength({ min: 1, max: 120 })
    .withMessage("relationship is required"),
];

router.post(
  "/applications/:applicationId",
  loginRequired,
  requireVerifiedEmail,
  validate([...applicationParams, ...refereeBody]),
  asyncHandler(references.addReferee, "add referee")
);

router.get(
  "/applications/:applicationId",
  loginRequired,
  requireVerifiedEmail,
  validate(applicationParams),
  asyncHandler(references.listReferees, "list referees")
);

router.get(
  "/applications/:applicationId/answers",
  loginRequired,
  requireVerifiedEmail,
  validate(applicationParams),
  asyncHandler(references.readReferences, "read references")
);

router.post(
  "/:referenceId/resend",
  loginRequired,
  requireVerifiedEmail,
  validate([param("referenceId").isUUID().withMessage("referenceId must be a valid id")]),
  asyncHandler(references.resendReference, "resend reference request")
);

const tokenParams = [
  param("token").isHexadecimal().isLength({ min: 64, max: 64 }).withMessage("invalid link"),
];

router.get(
  "/respond/:token",
  documentLinkLimiter,
  validate(tokenParams),
  asyncHandler(referenceLink.openLink, "open reference link")
);

router.post(
  "/respond/:token",
  documentLinkLimiter,
  validate(tokenParams),
  asyncHandler(referenceLink.submitAnswers, "submit reference answers")
);

export default (app: Router) => app.use("/references", router);
