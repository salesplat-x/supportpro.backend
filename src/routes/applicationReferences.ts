import { Router } from "express";
import { body, param } from "express-validator";
import * as references from "../controllers/applicationReferences.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { loginRequired, requireVerifiedEmail } from "../middleware/auth.js";
import { documentLinkLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import { MAX_REFEREES, REFEREE_RELATIONSHIPS } from "../services/applicationReferences.js";
import * as referenceLink from "../controllers/referenceLink.js";

const router = Router();

const applicationParams = [
  param("applicationId").isUUID().withMessage("applicationId must be a valid id"),
];

const refereeBody = [
  body("referees")
    .isArray({ min: 1, max: MAX_REFEREES })
    .withMessage(`referees must list 1 to ${MAX_REFEREES} people`),
  body("referees.*.name")
    .isString()
    .trim()
    .isLength({ min: 1, max: 120 })
    .withMessage("name is required"),
  body("referees.*.email").isString().trim().isEmail().withMessage("a valid email is required"),
  body("referees.*.relationship")
    .isIn([...REFEREE_RELATIONSHIPS])
    .withMessage(`relationship must be one of: ${REFEREE_RELATIONSHIPS.join(", ")}`),
];

router.post(
  "/applications/:applicationId",
  loginRequired,
  requireVerifiedEmail,
  validate([...applicationParams, ...refereeBody]),
  asyncHandler(references.addReferees, "send reference requests")
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
