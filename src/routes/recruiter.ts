import { Router } from "express";
import * as recruiter from "../controllers/recruiter.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess, requireVerifiedEmail } from "../middleware/auth.js";
import { UserRole } from "../types/enums.js";

const router = Router();

router.get(
  "/shortlist",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  asyncHandler(recruiter.shortlistedApplications, "load shortlist")
);
router.get(
  "/dashboard",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  asyncHandler(recruiter.recruiterDashboard, "load dashboard")
);
router.get(
  "/applications",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  asyncHandler(recruiter.recentApplications, "load recent applications")
);
router.get(
  "/compilations",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  asyncHandler(recruiter.recentCompilations, "load recent compilations")
);

export default (app: Router) => app.use("/recruiter", router);
