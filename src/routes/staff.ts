import { Router } from "express";
import * as staff from "../controllers/staff.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess, requireVerifiedEmail } from "../middleware/auth.js";
import { staffWriteLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import {
  accessLogValidator,
  createStaffValidator,
  endStaffValidator,
  listStaffValidator,
  companyParamValidator,
  staffIdValidator,
  staffOptionsValidator,
  updateStaffValidator,
} from "../validators/staff.js";

const router = Router({ mergeParams: true });

const recruiter = [validateAccess([UserRole.Recruiter]), requireVerifiedEmail];

router.get(
  "/access",
  ...recruiter,
  validate(companyParamValidator),
  asyncHandler(staff.access, "load your access to People")
);

router.get("/", ...recruiter, validate(listStaffValidator), asyncHandler(staff.list, "load staff"));

router.get(
  "/options",
  ...recruiter,
  validate(staffOptionsValidator),
  asyncHandler(staff.options, "load staff list")
);

router.get(
  "/access-log",
  ...recruiter,
  validate(accessLogValidator),
  asyncHandler(staff.accessLog, "load the access log")
);

router.post(
  "/",
  ...recruiter,
  staffWriteLimiter,
  validate(createStaffValidator),
  asyncHandler(staff.create, "add staff member")
);

router.get(
  "/:staffId",
  ...recruiter,
  validate(staffIdValidator),
  asyncHandler(staff.get, "load staff member")
);

router.patch(
  "/:staffId",
  ...recruiter,
  validate(updateStaffValidator),
  asyncHandler(staff.update, "update staff member")
);

router.post(
  "/:staffId/end",
  ...recruiter,
  validate(endStaffValidator),
  asyncHandler(staff.end, "end employment")
);

router.post(
  "/:staffId/invite",
  ...recruiter,
  staffWriteLimiter,
  validate(staffIdValidator),
  asyncHandler(staff.invite, "send invite")
);

router.get(
  "/:staffId/activity",
  ...recruiter,
  validate(staffIdValidator),
  asyncHandler(staff.activity, "load activity")
);

export default (app: Router) => app.use("/organizations/:_id/staff", router);
