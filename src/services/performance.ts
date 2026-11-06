import type { StaffMember } from "../entities/StaffMember.js";
import type { User } from "../entities/User.js";
import { weekStartOf, workToday } from "../utils/workCalendar.js";
import { type DevelopmentView, listDevelopment, toDevelopmentView } from "./development.js";
import {
  type EfficiencyTipView,
  type EfficiencyView,
  efficiencyFor,
  loadEfficiencyTip,
} from "./efficiency.js";
import { type FeedbackView, listFeedback } from "./monthlyFeedback.js";
import {
  type GoalView,
  type JobDescriptionView,
  listGoals,
  loadJobDescription,
  toGoalView,
  toJobDescriptionView,
} from "./goals.js";
import {
  type PerformanceScope,
  findOwnStaff,
  logPerformanceRead,
  openPerformance,
} from "./performanceAccess.js";
import { type ReportView, listReportsFor } from "./weeklyReports.js";
import { type CompletionRequestView, loadLatestRequests } from "./completionRequests.js";

const REPORTS_ON_TAB = 10;

export interface PerformanceView {
  staffId: string;
  isExecutive: boolean;
  jobDescription: JobDescriptionView | null;
  goals: GoalView[];
  reports: { items: ReportView[]; total: number };
  development: DevelopmentView[];
  feedback: FeedbackView[];
}

export interface ManagedPerformanceView extends PerformanceView {
  completionRequests: CompletionRequestView[];
  efficiency: EfficiencyView & { quarter: string };
  efficiencyTip: EfficiencyTipView | null;
}

const loadPerformance = async (staff: StaffMember, ownView: boolean): Promise<PerformanceView> => {
  const staffId = staff.id;
  const [jobDescription, goals, reports, development, feedback] = await Promise.all([
    loadJobDescription(staffId),
    listGoals(staffId, ownView),
    listReportsFor(staffId, REPORTS_ON_TAB, 0),
    listDevelopment(staffId, ownView),
    listFeedback(staffId),
  ]);
  return {
    staffId,
    isExecutive: staff.isExecutive,
    reports,
    development: development.map(toDevelopmentView),
    feedback,
    jobDescription: jobDescription ? toJobDescriptionView(jobDescription) : null,
    goals: goals.map(toGoalView),
  };
};

/** One logged read for the whole tab, so opening it writes one line and not one per card. */
export const getPerformance = async (
  scope: PerformanceScope,
  ip: string
): Promise<ManagedPerformanceView> => {
  const staff = await openPerformance(scope, ip);
  const [performance, efficiency, completionRequests] = await Promise.all([
    loadPerformance(staff, false),
    efficiencyFor(staff),
    loadLatestRequests([staff.id]),
  ]);
  return {
    ...performance,
    completionRequests,
    efficiency,
    efficiencyTip: await loadEfficiencyTip(staff.id, efficiency),
  };
};

export const getMyPerformance = async (
  actor: User,
  staffId: string,
  ip: string
): Promise<
  PerformanceView & { currentWeek: string; completionRequests: CompletionRequestView[] }
> => {
  const staff = await findOwnStaff(actor.id, staffId);
  await logPerformanceRead(actor, staff, ip);
  return {
    ...(await loadPerformance(staff, true)),
    completionRequests: await loadLatestRequests([staff.id]),
    currentWeek: weekStartOf(workToday()),
  };
};
