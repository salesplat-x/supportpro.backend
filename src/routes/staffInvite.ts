import { Router } from "express";
import * as staffInvite from "../controllers/staffInvite.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess, requireVerifiedEmail } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import { staffInviteTokenValidator, myStaffInviteValidator } from "../validators/staff.js";

const router = Router();

router.get(
  "/mine",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  asyncHandler(staffInvite.mine, "load your invites")
);

router.post(
  "/mine/:staffId/accept",
  validateAccess([UserRole.Talent]),
  requireVerifiedEmail,
  validate(myStaffInviteValidator),
  asyncHandler(staffInvite.acceptMine, "join company")
);

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
