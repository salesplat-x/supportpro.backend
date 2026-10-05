import { Router } from "express";
import * as aiConfig from "../controllers/aiConfig.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess, requireVerifiedEmail } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import {
  createAIConfigValidator,
  updateAIConfigValidator,
  aiConfigIdParamValidator,
} from "../validators/aiConfig.js";

const router = Router();

router.post(
  "/",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(createAIConfigValidator),
  asyncHandler(aiConfig.createAIConfig, "create AI configuration")
);
router.get(
  "/",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  asyncHandler(aiConfig.allAIConfig, "load AI configurations")
);
router.get(
  "/:_id",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(aiConfigIdParamValidator),
  asyncHandler(aiConfig.fetchAIConfig, "load AI configuration")
);
router.patch(
  "/:_id",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(updateAIConfigValidator),
  asyncHandler(aiConfig.update, "update AI configuration")
);
router.delete(
  "/:_id",
  validateAccess([UserRole.Recruiter, UserRole.Admin]),
  requireVerifiedEmail,
  validate(aiConfigIdParamValidator),
  asyncHandler(aiConfig.deleteAIConfig, "delete AI configuration")
);

export default (app: Router) => app.use("/ai-config", router);
