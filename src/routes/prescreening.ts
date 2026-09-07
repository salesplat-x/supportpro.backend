import { Router } from "express";
import * as prescreening from "../controllers/prescreening.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess, requireVerifiedEmail } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import { submitPreScreeningValidator } from "../validators/prescreening.js";

const router = Router();

router.get(
  "/",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  asyncHandler(prescreening.getPreScreening)
);
router.post(
  "/submit",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  validate(submitPreScreeningValidator),
  asyncHandler(prescreening.submitAnswers)
);
router.post(
  "/retake",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  asyncHandler(prescreening.requestRetake)
);
router.post(
  "/retry-generation",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  asyncHandler(prescreening.retryGeneration)
);

export default (app: Router) => app.use("/prescreening", router);
