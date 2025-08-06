import { Router } from "express";
import {
  getErrorLogs,
  getErrorStats,
  markErrorAsResolved,
  cleanupOldLogs,
} from "../../controllers/v1/errorLogs";
import { validateAccess } from "../../middlewares/v1/auth";
import { Roles } from "../../typings/customs";

const router = Router();

router.use(validateAccess([Roles.Superadmin]))

router.get("/", getErrorLogs);

router.get("/stats", getErrorStats);

router.patch("/:requestId/resolve", markErrorAsResolved);

router.delete("/cleanup", cleanupOldLogs);

export default (app: Router) => app.use("/error-logs", router);
