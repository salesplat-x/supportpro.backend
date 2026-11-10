import { Router } from "express";
import * as recruiter from "../controllers/recruiter.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess, requireVerifiedEmail } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import {
  dashboardApplicantsValidator,
  dashboardSummaryValidator,
} from "../validators/recruiter.js";

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
  "/dashboard/summary",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(dashboardSummaryValidator),
  asyncHandler(recruiter.dashboardSummary, "load dashboard summary")
);
router.get(
  "/dashboard/applicants",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  validate(dashboardApplicantsValidator),
  asyncHandler(recruiter.dashboardApplicants, "load dashboard applicants")
);
router.get(
  "/dashboard/counts",
  validateAccess([UserRole.Recruiter]),
  requireVerifiedEmail,
  asyncHandler(recruiter.dashboardCounts, "load dashboard counts")
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
