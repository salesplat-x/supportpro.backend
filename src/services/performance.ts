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

export interface PerformanceView {
  staffId: string;
  jobDescription: JobDescriptionView | null;
  goals: GoalView[];
}

const loadPerformance = async (staffId: string, ownView: boolean): Promise<PerformanceView> => {
  const [jobDescription, goals] = await Promise.all([
    loadJobDescription(staffId),
    listGoals(staffId, ownView),
  ]);
  return {
    staffId,
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
  return loadPerformance(staff.id, false);
};

export const getMyPerformance = async (
  actor: User,
  staffId: string,
  ip: string
): Promise<PerformanceView> => {
  const staff = await findOwnStaff(actor.id, staffId);
  await logPerformanceRead(actor, staff, ip);
  return loadPerformance(staff.id, true);
};
