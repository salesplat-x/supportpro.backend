import { Router } from "express";
import * as staffInvite from "../controllers/staffInvite.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess, requireVerifiedEmail } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import { staffInviteTokenValidator } from "../validators/staff.js";

const router = Router();

router.get(
  "/:token",
  validate(staffInviteTokenValidator),
  asyncHandler(staffInvite.preview, "load invite")
);

router.post(
  "/:token/accept",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  validate(staffInviteTokenValidator),
  asyncHandler(staffInvite.accept, "join company")
);

export default (app: Router) => app.use("/staff-invites", router);
