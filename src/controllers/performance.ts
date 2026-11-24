import { Request, Response } from "express";
import type { DevelopmentStatus } from "../entities/StaffDevelopmentItem.js";
import * as completion from "../services/completionRequests.js";
import * as development from "../services/development.js";
import { requestEfficiencyTip } from "../services/efficiency.js";
import * as goalReportService from "../services/goalReports.js";
import * as goals from "../services/goals.js";
import { saveFeedback as saveMonthlyFeedback } from "../services/monthlyFeedback.js";
import * as myWorkService from "../services/myWork.js";
import { getMyPerformance, getPerformance } from "../services/performance.js";
import type { PerformanceScope } from "../services/performanceAccess.js";
import { getQuarterlyReview, saveQuarterGoal } from "../services/quarterlyReview.js";
import * as weeklyReports from "../services/weeklyReports.js";
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
  reportFrequency: req.body.reportFrequency as goals.GoalInput["reportFrequency"],
});

/** Always a download with a fixed type, so an evidence file can never run as a page on our site. */
export const sendEvidence = (
  res: Response,
  evidence: { fileName: string; contentType: string; file: Buffer }
): void => {
  const asciiName = evidence.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  res.setHeader("Content-Type", evidence.contentType);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(evidence.fileName)}`
  );
  res.setHeader("Content-Length", evidence.file.length);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(evidence.file);
};

export const tasks = async (req: Request, res: Response) => {
  sendSuccessResponse(res, "Tasks fetched", {
    tasks: await completion.listScopedTasks(scopeOf(req), getClientIp(req)),
  });
};

export const completeTask = async (req: Request, res: Response) => {
  sendSuccessResponse(
    res,
    "Task marked complete",
    await completion.completeTaskDirectly(scopeOf(req), req.params["taskId"]!)
  );
};

export const reopenTask = async (req: Request, res: Response) => {
  sendSuccessResponse(
    res,
    "Task reopened",
    await completion.reopenTask(scopeOf(req), req.params["taskId"]!)
  );
};

export const completeGoal = async (req: Request, res: Response) => {
  sendSuccessResponse(
    res,
    "Goal marked complete",
    await completion.completeGoalDirectly(
      scopeOf(req),
      req.params["goalId"]!,
      req.body.version as number
    )
  );
};

export const reopenGoal = async (req: Request, res: Response) => {
  sendSuccessResponse(
    res,
    "Goal reopened",
    await completion.reopenGoal(scopeOf(req), req.params["goalId"]!)
  );
};

export const approveCompletion = async (req: Request, res: Response) => {
  sendSuccessResponse(
    res,
    "Marked complete",
    await completion.approveCompletionRequest(scopeOf(req), req.params["requestId"]!, {
      version: req.body.version as number | undefined,
      note: (req.body.note as string | null | undefined) || null,
    })
  );
};

export const returnCompletion = async (req: Request, res: Response) => {
  sendSuccessResponse(
    res,
    "Sent back",
    await completion.returnCompletionRequest(
      scopeOf(req),
      req.params["requestId"]!,
      req.body.note as string
    )
  );
};

export const evidenceFile = async (req: Request, res: Response) => {
  sendEvidence(
    res,
    await completion.downloadEvidence(
      scopeOf(req),
      req.params["requestId"]!,
      req.params["fileId"]!,
      getClientIp(req)
    )
  );
};

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

export const approveGoals = async (req: Request, res: Response) => {
  const approved = await goals.approveGoals(
    scopeOf(req),
    (req.body.goals as { id: string; version: number }[]).map(({ id, version }) => ({
      goalId: id,
      version,
    }))
  );
  sendSuccessResponse(res, "Goals approved", { goals: approved });
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

const page = (req: Request) => ({
  limit: Number(req.query["limit"] ?? 10),
  offset: Number(req.query["offset"] ?? 0),
});

export const reports = async (req: Request, res: Response) => {
  const { limit, offset } = page(req);
  sendSuccessResponse(
    res,
    "Reports fetched",
    await weeklyReports.listReports(scopeOf(req), limit, offset, getClientIp(req))
  );
};

export const addReportNote = async (req: Request, res: Response) => {
  const report = await weeklyReports.addReportNote(
    scopeOf(req),
    req.params["weeklyReportId"]!,
    req.body.note as string,
    req.body.textVersion as number,
    req.body.noteVersion as number
  );
  sendSuccessResponse(res, "Note saved", { report });
};

export const myReports = async (req: Request, res: Response) => {
  const { limit, offset } = page(req);
  sendSuccessResponse(
    res,
    "Reports fetched",
    await weeklyReports.listMyReports(
      req.user,
      req.params["staffId"]!,
      limit,
      offset,
      getClientIp(req)
    )
  );
};

export const submitReport = async (req: Request, res: Response) => {
  const report = await weeklyReports.submitReport(
    req.user,
    req.params["staffId"]!,
    req.params["weekStart"]!,
    {
      did: req.body.did as string,
      blocked: req.body.blocked as string,
      nextWeek: req.body.nextWeek as string,
    }
  );
  sendSuccessResponse(res, "Report submitted", { report });
};

export const requestAdvice = async (req: Request, res: Response) => {
  const report = await weeklyReports.requestAdvice(
    req.user,
    req.params["staffId"]!,
    req.params["weeklyReportId"]!,
    getClientIp(req)
  );
  sendSuccessResponse(res, "Advice ready", { report });
};

export const myTeam = async (req: Request, res: Response) => {
  sendSuccessResponse(
    res,
    "Team fetched",
    await weeklyReports.getMyTeam(req.user, req.params["staffId"]!, getClientIp(req))
  );
};

export const teamMemberDetails = async (req: Request, res: Response) => {
  sendSuccessResponse(
    res,
    "Details fetched",
    await myWorkService.getTeamMemberDetails(
      req.user,
      req.params["staffId"]!,
      req.params["reportId"]!,
      getClientIp(req)
    )
  );
};

const developmentInput = (req: Request): development.DevelopmentInput => ({
  weakArea: req.body.weakArea as string,
  action: req.body.action as string,
  dueOn: (req.body.dueOn as string | null | undefined) ?? null,
});

export const addDevelopmentItem = async (req: Request, res: Response) => {
  const item = await development.addDevelopmentItem(scopeOf(req), developmentInput(req));
  sendSuccessResponse(res, "Plan item added", { item }, 201);
};

export const editDevelopmentItem = async (req: Request, res: Response) => {
  const item = await development.editDevelopmentItem(
    scopeOf(req),
    req.params["itemId"]!,
    { ...developmentInput(req), status: req.body.status as DevelopmentStatus },
    req.body.version as number
  );
  sendSuccessResponse(res, "Plan item saved", { item });
};

export const removeDevelopmentItem = async (req: Request, res: Response) => {
  await development.removeDevelopmentItem(scopeOf(req), req.params["itemId"]!);
  sendSuccessResponse(res, "Plan item removed", {});
};

export const suggestDevelopmentItems = async (req: Request, res: Response) => {
  const items = await development.suggestDevelopmentItems(scopeOf(req), getClientIp(req));
  sendSuccessResponse(res, "Plan items suggested", { items });
};

export const setDevelopmentDone = async (req: Request, res: Response) => {
  const item = await development.setDevelopmentDone(
    req.user,
    req.params["staffId"]!,
    req.params["itemId"]!,
    req.body.done as boolean
  );
  sendSuccessResponse(res, "Plan item saved", { item });
};

export const saveFeedback = async (req: Request, res: Response) => {
  const feedback = await saveMonthlyFeedback(
    scopeOf(req),
    req.params["month"]!,
    { rating: req.body.rating as number, notes: req.body.notes as string },
    req.body.version as number | null
  );
  sendSuccessResponse(res, "Feedback saved", { feedback });
};

export const efficiencyTip = async (req: Request, res: Response) => {
  sendSuccessResponse(res, "Tip ready", {
    tip: await requestEfficiencyTip(scopeOf(req), getClientIp(req)),
  });
};

export const quarterlyReview = async (req: Request, res: Response) => {
  sendSuccessResponse(
    res,
    "Quarterly review fetched",
    await getQuarterlyReview(
      req.user,
      req.params["_id"]!,
      req.query["quarter"] as string | undefined,
      getClientIp(req)
    )
  );
};

export const quarterGoal = async (req: Request, res: Response) => {
  const goal = await saveQuarterGoal(req.user, req.params["_id"]!, {
    quarter: req.body.quarter as string,
    currency: req.body.currency as string,
    revenueGoal: req.body.revenueGoal as number,
    revenueSoFar: req.body.revenueSoFar as number,
    version: req.body.version as number | null,
  });
  sendSuccessResponse(res, "Revenue goal saved", { goal });
};

export const goalReports = async (req: Request, res: Response) => {
  sendSuccessResponse(
    res,
    "Reports fetched",
    await goalReportService.listGoalReports(scopeOf(req), req.params["goalId"]!, getClientIp(req))
  );
};

export const noteGoalReport = async (req: Request, res: Response) => {
  const report = await goalReportService.addGoalReportNote(
    scopeOf(req),
    req.params["goalId"]!,
    req.params["goalReportId"]!,
    req.body.note as string,
    req.body.textVersion as number,
    req.body.noteVersion as number
  );
  sendSuccessResponse(res, "Note saved", { report });
};

export const goalReportFile = async (req: Request, res: Response) => {
  sendEvidence(
    res,
    await goalReportService.downloadGoalReportFile(
      scopeOf(req),
      req.params["goalId"]!,
      req.params["goalReportId"]!,
      req.params["fileId"]!,
      getClientIp(req)
    )
  );
};
