import { Router } from "express";

const router = Router();

import * as controller from "../../controllers/v1/aiconfig";
import validate from "../../middlewares/v1/validators/validate";
import * as validator from "../../middlewares/v1/validators/aiconfig";
import { asyncHandler } from "../../middlewares/v1/handler";
import { validateAccess } from "../../middlewares/v1/auth";
import { Roles } from "../../typings/customs";

// Endpoint to create AI configuration
router.post(
  "/",
  validateAccess([Roles.Recruiter, Roles.Admin]),
  validate(validator.aiConfig, { body: true }),
  asyncHandler(controller.createAIConfig)
);

router.get(
  "/",
  validateAccess([Roles.Recruiter, Roles.Admin]),
  asyncHandler(controller.allAIConfig)
);

router.get(
  "/:_id",
  validateAccess([Roles.Recruiter, Roles.Admin]),
  validate(validator.id, { params: true }),
  asyncHandler(controller.fetchAIConfig)
);

router.patch(
  "/:_id",
  validateAccess([Roles.Recruiter, Roles.Admin]),
  validate(validator.update, { params: true, body: true }),
  asyncHandler(controller.update)
);

router.delete(
  "/:_id",
  validateAccess([Roles.Recruiter, Roles.Admin]),
  asyncHandler(controller.deleteAIConfig)
);

export default (app: Router) => app.use("/ai-config", router);
