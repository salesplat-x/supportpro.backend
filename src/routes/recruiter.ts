import { Router } from "express";
import * as recruiter from "../controllers/recruiter.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { validateAccess } from "../middleware/auth.js";
import { UserRole } from "../types/enums.js";

const router = Router();

router.get("/shortlist", validateAccess([UserRole.Recruiter]), asyncHandler(recruiter.recentApplications));
router.get("/dashboard", validateAccess([UserRole.Recruiter]), asyncHandler(recruiter.recruiterDashboard));
router.get("/applications", validateAccess([UserRole.Recruiter]), asyncHandler(recruiter.recentApplications));
router.get("/compilations", validateAccess([UserRole.Recruiter]), asyncHandler(recruiter.recentCompilations));

export default (app: Router) => app.use("/recruiter", router);
