import { Request, Response } from "express";
import * as goals from "../services/goals.js";
import { getMyPerformance, getPerformance } from "../services/performance.js";
import type { PerformanceScope } from "../services/performanceAccess.js";
import { getClientIp } from "../utils/clientIp.js";
import { sendSuccessResponse } from "../utils/response.js";

/** The same handlers serve HR's and a manager's routes. Which right applies comes from the path. */
const scopeOf = (req: Request): PerformanceScope =>
  req.params["_id"]
    ? {
        kind: "hr",
        actor: req.user,
        organizationId: req.params["_id"],
        staffId: req.params["staffId"]!,
      }
    : {
        kind: "manager",
        actor: req.user,
        managerStaffId: req.params["staffId"]!,
        staffId: req.params["reportId"]!,
      };

const goalInput = (req: Request): goals.GoalInput => ({
  title: req.body.title as string,
  keyResults: req.body.keyResults as string[],
  target: (req.body.target as string | null | undefined) || null,
  dueOn: req.body.dueOn as string,
});

export const performance = async (req: Request, res: Response) => {
  sendSuccessResponse(res, "Performance fetched", {
    performance: await getPerformance(scopeOf(req), getClientIp(req)),
  });
};

export const myPerformance = async (req: Request, res: Response) => {
  sendSuccessResponse(res, "Performance fetched", {
    performance: await getMyPerformance(req.user, req.params["staffId"]!, getClientIp(req)),
  });
};

export const writeJobDescription = async (req: Request, res: Response) => {
  const draft = await goals.writeJobDescription(
    req.user,
    req.params["_id"]!,
    req.params["staffId"]!
  );
  sendSuccessResponse(res, "Job description written", { draft });
};

export const saveJobDescription = async (req: Request, res: Response) => {
  const jobDescription = await goals.saveJobDescription(
    req.user,
    req.params["_id"]!,
    req.params["staffId"]!,
    req.body.body as string,
    req.body.version as number | null
  );
  sendSuccessResponse(res, "Job description saved", { jobDescription });
};

export const addGoal = async (req: Request, res: Response) => {
  const goal = await goals.addGoal(scopeOf(req), goalInput(req));
  sendSuccessResponse(res, "Goal added", { goal }, 201);
};

export const editGoal = async (req: Request, res: Response) => {
  const goal = await goals.editGoal(
    scopeOf(req),
    req.params["goalId"]!,
    goalInput(req),
    req.body.version as number
  );
  sendSuccessResponse(res, "Goal saved", { goal });
};

export const approveGoal = async (req: Request, res: Response) => {
  const goal = await goals.approveGoal(
    scopeOf(req),
    req.params["goalId"]!,
    req.body.version as number
  );
  sendSuccessResponse(res, "Goal approved", { goal });
};

export const removeGoal = async (req: Request, res: Response) => {
  await goals.removeGoal(scopeOf(req), req.params["goalId"]!);
  sendSuccessResponse(res, "Goal removed", {});
};

export const suggestGoals = async (req: Request, res: Response) => {
  const suggested = await goals.suggestGoals(scopeOf(req), getClientIp(req));
  sendSuccessResponse(res, "Goals suggested", { goals: suggested });
};

export const setGoalProgress = async (req: Request, res: Response) => {
  const goal = await goals.setGoalProgress(
    req.user,
    req.params["staffId"]!,
    req.params["goalId"]!,
    req.body.progress as number
  );
  sendSuccessResponse(res, "Progress saved", { goal });
};
