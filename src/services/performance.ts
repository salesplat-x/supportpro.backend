import type { StaffMember } from "../entities/StaffMember.js";
import type { User } from "../entities/User.js";
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

const REPORTS_ON_TAB = 10;

export interface PerformanceView {
  staffId: string;
  isExecutive: boolean;
  jobDescription: JobDescriptionView | null;
  goals: GoalView[];
  reports: { items: ReportView[]; total: number };
}

const loadPerformance = async (staff: StaffMember, ownView: boolean): Promise<PerformanceView> => {
  const staffId = staff.id;
  const [jobDescription, goals, reports] = await Promise.all([
    loadJobDescription(staffId),
    listGoals(staffId, ownView),
    listReportsFor(staffId, REPORTS_ON_TAB, 0),
  ]);
  return {
    staffId,
    isExecutive: staff.isExecutive,
    reports,
    jobDescription: jobDescription ? toJobDescriptionView(jobDescription) : null,
    goals: goals.map(toGoalView),
  };
};

/** One logged read for the whole tab, so opening it writes one line and not one per card. */
export const getPerformance = async (
  scope: PerformanceScope,
  ip: string
): Promise<PerformanceView> => {
  const staff = await openPerformance(scope, ip);
  return loadPerformance(staff, false);
};

export const getMyPerformance = async (
  actor: User,
  staffId: string,
  ip: string
): Promise<PerformanceView> => {
  const staff = await findOwnStaff(actor.id, staffId);
  await logPerformanceRead(actor, staff, ip);
  return loadPerformance(staff, true);
};
