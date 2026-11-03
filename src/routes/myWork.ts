import { Router } from "express";
import * as myWork from "../controllers/myWork.js";
import * as performance from "../controllers/performance.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireVerifiedEmail, validateAccess } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { UserRole } from "../types/enums.js";
import { registerSharedPerformanceRoutes } from "./performance.js";
import { goalProgressValidator, managerParams, selfParams } from "../validators/performance.js";
import {
  myDocumentValidator,
  myStaffValidator,
  myTaskValidator,
  signMyDocumentValidator,
} from "../validators/staff.js";

const router = Router();

const employee = [validateAccess([UserRole.Talent]), requireVerifiedEmail];

router.get("/", ...employee, asyncHandler(myWork.overview, "load my work"));

router.get(
  "/:staffId/pay",
  ...employee,
  validate(myStaffValidator),
  asyncHandler(myWork.pay, "load my pay")
);

router.patch(
  "/tasks/:taskId",
  ...employee,
  validate(myTaskValidator),
  asyncHandler(myWork.setTaskDone, "update task")
);

router.get(
  "/documents/:documentId",
  ...employee,
  validate(myDocumentValidator),
  asyncHandler(myWork.openDocument, "load document")
);

router.get(
  "/documents/:documentId/pdf",
  ...employee,
  validate(myDocumentValidator),
  asyncHandler(myWork.downloadDocument, "download document")
);

router.post(
  "/documents/:documentId/sign",
  ...employee,
  validate(signMyDocumentValidator),
  asyncHandler(myWork.signDocument, "sign document")
);

router.get(
  "/:staffId/performance",
  ...employee,
  validate(selfParams),
  asyncHandler(performance.myPerformance, "load my performance")
);

router.patch(
  "/:staffId/goals/:goalId/progress",
  ...employee,
  validate(goalProgressValidator),
  asyncHandler(performance.setGoalProgress, "save progress")
);

registerSharedPerformanceRoutes(router, "/:staffId/team/:reportId", employee, managerParams);

export default (app: Router) => app.use("/my-work", router);
