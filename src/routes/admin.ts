import { Router } from "express";
import * as admin from "../controllers/admin.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import {
  adminIdParamValidator,
  adminJobsQueryValidator,
  adminRecruitersQueryValidator,
  adminTalentsQueryValidator,
} from "../validators/admin.js";

const router = Router();

router.get(
  "/talents",
  validateAccess([UserRole.Admin]),
  validate(adminTalentsQueryValidator),
  asyncHandler(admin.listTalents)
);
router.delete(
  "/talents/:_id",
  validateAccess([UserRole.Admin]),
  validate(adminIdParamValidator),
  asyncHandler(admin.deleteTalent)
);

router.get(
  "/recruiters",
  validateAccess([UserRole.Admin]),
  validate(adminRecruitersQueryValidator),
  asyncHandler(admin.listRecruiters)
);
router.delete(
  "/recruiters/:_id",
  validateAccess([UserRole.Admin]),
  validate(adminIdParamValidator),
  asyncHandler(admin.deleteRecruiter)
);

router.get(
  "/jobs",
  validateAccess([UserRole.Admin]),
  validate(adminJobsQueryValidator),
  asyncHandler(admin.listJobs)
);
router.delete(
  "/jobs/:_id",
  validateAccess([UserRole.Admin]),
  validate(adminIdParamValidator),
  asyncHandler(admin.deleteJob)
);

export default (app: Router) => app.use("/admin", router);
