import type { RequestHandler, Router } from "express";
import type { ValidationChain } from "express-validator";
import * as performance from "../controllers/performance.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { peopleAiLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import {
  addGoalValidator,
  approveGoalValidator,
  editGoalValidator,
  goalIdValidator,
} from "../validators/performance.js";

/** The routes HR and a manager share. Only the path's prefix and its parameters differ. */
export const registerSharedPerformanceRoutes = (
  router: Router,
  prefix: string,
  guard: RequestHandler[],
  params: ValidationChain[]
): void => {
  router.get(
    prefix,
    ...guard,
    validate(params),
    asyncHandler(performance.performance, "load performance")
  );
  router.post(
    `${prefix}/goals`,
    ...guard,
    validate([...params, ...addGoalValidator]),
    asyncHandler(performance.addGoal, "add goal")
  );
  router.post(
    `${prefix}/goals/suggest`,
    ...guard,
    peopleAiLimiter,
    validate(params),
    asyncHandler(performance.suggestGoals, "suggest goals")
  );
  router.patch(
    `${prefix}/goals/:goalId`,
    ...guard,
    validate([...params, ...editGoalValidator]),
    asyncHandler(performance.editGoal, "save goal")
  );
  router.post(
    `${prefix}/goals/:goalId/approve`,
    ...guard,
    validate([...params, ...approveGoalValidator]),
    asyncHandler(performance.approveGoal, "approve goal")
  );
  router.delete(
    `${prefix}/goals/:goalId`,
    ...guard,
    validate([...params, ...goalIdValidator]),
    asyncHandler(performance.removeGoal, "remove goal")
  );
};
