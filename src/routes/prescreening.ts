import { Router } from "express";
import * as prescreening from "../controllers/prescreening.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import { submitPreScreeningValidator } from "../validators/prescreening.js";

const router = Router();

router.get("/", validateAccess([UserRole.Talent]), asyncHandler(prescreening.getPreScreening));
router.post(
  "/submit",
  validateAccess([UserRole.Talent]),
  validate(submitPreScreeningValidator),
  asyncHandler(prescreening.submitAnswers)
);
router.post("/retake", validateAccess([UserRole.Talent]), asyncHandler(prescreening.requestRetake));

export default (app: Router) => app.use("/prescreening", router);
