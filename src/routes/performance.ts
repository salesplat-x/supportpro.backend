import type { RequestHandler, Router } from "express";
import type { ValidationChain } from "express-validator";
import * as performance from "../controllers/performance.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { peopleAiLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import {
  addDevelopmentValidator,
  addGoalValidator,
  approveCompletionValidator,
  approveGoalValidator,
  approveGoalsValidator,
  completeGoalValidator,
  evidenceValidator,
  reopenGoalValidator,
  returnCompletionValidator,
  taskActionValidator,
  developmentIdValidator,
  editDevelopmentValidator,
  editGoalValidator,
  feedbackValidator,
  goalIdValidator,
  goalReportFileValidator,
  goalReportNoteValidator,
  goalReportsValidator,
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
  router.get(
    `${prefix}/tasks`,
    ...guard,
    validate(params),
    asyncHandler(performance.tasks, "load tasks")
  );
  router.post(
    `${prefix}/tasks/:taskId/complete`,
    ...guard,
    validate([...params, ...taskActionValidator]),
    asyncHandler(performance.completeTask, "mark task complete")
  );
  router.post(
    `${prefix}/tasks/:taskId/reopen`,
    ...guard,
    validate([...params, ...taskActionValidator]),
    asyncHandler(performance.reopenTask, "reopen task")
  );
  router.post(
    `${prefix}/goals/:goalId/complete`,
    ...guard,
    validate([...params, ...completeGoalValidator]),
    asyncHandler(performance.completeGoal, "mark goal complete")
  );
  router.post(
    `${prefix}/goals/:goalId/reopen`,
    ...guard,
    validate([...params, ...reopenGoalValidator]),
    asyncHandler(performance.reopenGoal, "reopen goal")
  );
  router.post(
    `${prefix}/completion-requests/:requestId/approve`,
    ...guard,
    validate([...params, ...approveCompletionValidator]),
    asyncHandler(performance.approveCompletion, "approve completion")
  );
  router.post(
    `${prefix}/completion-requests/:requestId/return`,
    ...guard,
    validate([...params, ...returnCompletionValidator]),
    asyncHandler(performance.returnCompletion, "send back for more work")
  );
  router.get(
    `${prefix}/completion-requests/:requestId/files/:fileId`,
    ...guard,
    validate([...params, ...evidenceValidator]),
    asyncHandler(performance.evidenceFile, "download evidence")
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
    `${prefix}/goals/approve`,
    ...guard,
    validate([...params, ...approveGoalsValidator]),
    asyncHandler(performance.approveGoals, "approve goals")
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
  router.get(
    `${prefix}/goals/:goalId/reports`,
    ...guard,
    validate([...params, ...goalReportsValidator]),
    asyncHandler(performance.goalReports, "load goal reports")
  );
  router.put(
    `${prefix}/goals/:goalId/reports/:goalReportId/note`,
    ...guard,
    validate([...params, ...goalReportNoteValidator]),
    asyncHandler(performance.noteGoalReport, "save goal report note")
  );
  router.get(
    `${prefix}/goals/:goalId/reports/:goalReportId/files/:fileId`,
    ...guard,
    validate([...params, ...goalReportFileValidator]),
    asyncHandler(performance.goalReportFile, "download goal report file")
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
  router.post(
    `${prefix}/efficiency-tip`,
    ...guard,
    peopleAiLimiter,
    validate(params),
    asyncHandler(performance.efficiencyTip, "get a tip")
  );
  router.put(
    `${prefix}/feedback/:month`,
    ...guard,
    validate([...params, ...feedbackValidator]),
    asyncHandler(performance.saveFeedback, "save feedback")
  );
};
