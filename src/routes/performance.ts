import type { RequestHandler, Router } from "express";
import type { ValidationChain } from "express-validator";
import * as performance from "../controllers/performance.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { peopleAiLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import {
  addDevelopmentValidator,
  addGoalValidator,
  approveGoalValidator,
  developmentIdValidator,
  editDevelopmentValidator,
  editGoalValidator,
  feedbackValidator,
  goalIdValidator,
  reportNoteValidator,
  reportsPageValidator,
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
  router.get(
    `${prefix}/reports`,
    ...guard,
    validate([...params, ...reportsPageValidator]),
    asyncHandler(performance.reports, "load reports")
  );
  router.put(
    `${prefix}/reports/:weeklyReportId/note`,
    ...guard,
    validate([...params, ...reportNoteValidator]),
    asyncHandler(performance.addReportNote, "save note")
  );
  router.post(
    `${prefix}/development`,
    ...guard,
    validate([...params, ...addDevelopmentValidator]),
    asyncHandler(performance.addDevelopmentItem, "add plan item")
  );
  router.post(
    `${prefix}/development/suggest`,
    ...guard,
    peopleAiLimiter,
    validate(params),
    asyncHandler(performance.suggestDevelopmentItems, "suggest plan items")
  );
  router.patch(
    `${prefix}/development/:itemId`,
    ...guard,
    validate([...params, ...editDevelopmentValidator]),
    asyncHandler(performance.editDevelopmentItem, "save plan item")
  );
  router.delete(
    `${prefix}/development/:itemId`,
    ...guard,
    validate([...params, ...developmentIdValidator]),
    asyncHandler(performance.removeDevelopmentItem, "remove plan item")
  );
  router.put(
    `${prefix}/feedback/:month`,
    ...guard,
    validate([...params, ...feedbackValidator]),
    asyncHandler(performance.saveFeedback, "save feedback")
  );
};
