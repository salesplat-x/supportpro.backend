import { AppDataSource } from "../database/dataSource.js";
import { CompanyQuarterGoal } from "../entities/CompanyQuarterGoal.js";
import { StaffAccessResource } from "../entities/StaffAccessLog.js";
import type { User } from "../entities/User.js";
import { ConflictError } from "../utils/errors";
import { daysBetween, quarterFromKey, quarterOf, workToday } from "../utils/workCalendar.js";
import { computeEfficiency, loadEfficiencyInputs } from "./efficiency.js";
import { assertCanManagePeople } from "./peopleAccess.js";
import { isUniqueViolation } from "./staffRecord.js";
import { logStaffAccess } from "./staffAudit.js";
import { fullNameOf } from "./staffRecord.js";

const MAX_PEOPLE = 1000;
const WINDOW_DAYS = 28;
const NEW_GOAL_DAYS = 7;
const DAY_MS = 86_400_000;

/** A rough guide, always shown as "Directional". */
export const CAPACITY_THRESHOLDS = {
  minDaysEmployed: WINDOW_DAYS,
  highMaxOpenGoals: 3,
  highMinPace: 25,
  lowMinOpenGoals: 6,
  lowMaxPace: 10,
} as const;

export type Capacity = "not_enough_data" | "low" | "medium" | "high";

export const capacityLabel = (input: {
  daysEmployed: number;
  openGoals: number;
  onlyNewGoals: boolean;
  pace: number;
}): Capacity => {
  if (input.daysEmployed < CAPACITY_THRESHOLDS.minDaysEmployed) return "not_enough_data";
  if (input.openGoals === 0) return "high";
  if (input.onlyNewGoals) return "not_enough_data";
  if (input.openGoals >= CAPACITY_THRESHOLDS.lowMinOpenGoals) return "low";
  if (input.pace < CAPACITY_THRESHOLDS.lowMaxPace) return "low";
  if (
    input.openGoals <= CAPACITY_THRESHOLDS.highMaxOpenGoals &&
    input.pace >= CAPACITY_THRESHOLDS.highMinPace
  ) {
    return "high";
  }
  return "medium";
};

interface CapacityGoalRow {
  awaiting_review: boolean;
  staff_id: string;
  progress: number;
  start_progress: number;
  approved_at: Date;
}

/** Counts every goal open at any point in the window, so finishing work doesn't lower pace. */
const loadCapacityGoals = (organizationId: string, ids: string[]): Promise<CapacityGoalRow[]> =>
  AppDataSource.query(
    `SELECT g.staff_id, g.progress, g.approved_at,
       COALESCE(
         (SELECT e.to_progress FROM staff_goal_progress_events e
          WHERE e.goal_id = g.id AND e.created_at < NOW() - make_interval(days => $3)
          ORDER BY e.created_at DESC LIMIT 1),
         (SELECT e.from_progress FROM staff_goal_progress_events e
          WHERE e.goal_id = g.id AND e.created_at >= NOW() - make_interval(days => $3)
          ORDER BY e.created_at ASC LIMIT 1),
         g.progress
       ) AS start_progress,
       EXISTS (
         SELECT 1 FROM staff_completion_requests r
         WHERE r.goal_id = g.id AND r.status = 'pending'
       ) AS awaiting_review
     FROM staff_goals g
     WHERE g.organization_id = $1 AND g.staff_id = ANY($2::uuid[]) AND g.status = 'approved'
       AND (g.progress < 100 OR EXISTS (
         SELECT 1 FROM staff_goal_progress_events e
         WHERE e.goal_id = g.id AND e.created_at >= NOW() - make_interval(days => $3)
       ))`,
    [organizationId, ids, WINDOW_DAYS]
  );

const capacityOf = (goals: CapacityGoalRow[], daysEmployed: number): Capacity => {
  const open = goals.filter((goal) => goal.progress < 100 && !goal.awaiting_review);
  const newSince = Date.now() - NEW_GOAL_DAYS * DAY_MS;
  const gains = goals.map((goal) => Math.max(0, goal.progress - goal.start_progress));
  return capacityLabel({
    daysEmployed,
    openGoals: open.length,
    onlyNewGoals:
      open.length > 0 && open.every((goal) => new Date(goal.approved_at).getTime() > newSince),
    pace: goals.length > 0 ? gains.reduce((sum, gain) => sum + gain, 0) / goals.length : 0,
  });
};

export interface QuarterGoalView {
  quarter: string;
  currency: string;
  revenueGoal: number;
  revenueSoFar: number;
  version: number;
  updatedByName: string;
  updatedAt: Date;
}

export interface QuarterlyReviewPerson {
  staffId: string;
  fullName: string;
  jobTitle: string;
  department: string | null;
  goalProgress: number | null;
  score: number | null;
  partial: boolean;
  capacity: Capacity;
}

const goalsRepo = () => AppDataSource.getRepository(CompanyQuarterGoal);

const toGoalView = (goal: CompanyQuarterGoal): QuarterGoalView => ({
  quarter: goal.quarter,
  currency: goal.currency,
  revenueGoal: goal.revenueGoal,
  revenueSoFar: goal.revenueSoFar,
  version: goal.version,
  updatedByName: goal.updatedByName,
  updatedAt: goal.updatedAt,
});

/** The same number of queries for any size of company. */
export const getQuarterlyReview = async (
  actor: User,
  organizationId: string,
  quarterKey: string | undefined,
  ip: string
) => {
  await assertCanManagePeople(actor.id, organizationId);
  await logStaffAccess({
    organizationId,
    actor,
    staff: { id: null, fullName: "all staff" },
    resource: StaffAccessResource.Performance,
    ip,
  });
  const today = workToday();
  const quarter = quarterKey ? quarterFromKey(quarterKey) : quarterOf(today);
  const rows: Array<{
    id: string;
    full_name: string;
    job_title: string;
    department: string | null;
    start_date: string;
    user_id: string | null;
    joined_at: Date | null;
  }> = await AppDataSource.query(
    `SELECT id, full_name, job_title, department, to_char(start_date, 'YYYY-MM-DD') AS start_date,
            user_id, joined_at
     FROM staff_members
     WHERE organization_id = $1 AND end_date IS NULL AND start_date <= $2
     ORDER BY full_name, id
     LIMIT $3`,
    [organizationId, today, MAX_PEOPLE + 1]
  );
  const people = rows.slice(0, MAX_PEOPLE);
  const ids = people.map((person) => person.id);
  const [inputs, capacityGoals, goal] = await Promise.all([
    loadEfficiencyInputs(
      people.map((person) => ({
        id: person.id,
        startDate: person.start_date,
        userId: person.user_id,
        joinedAt: person.joined_at,
      })),
      quarter,
      today
    ),
    loadCapacityGoals(organizationId, ids),
    goalsRepo().findOne({ where: { organizationId, quarter: quarter.key } }),
  ]);

  const list: QuarterlyReviewPerson[] = people.map((person) => {
    const personInputs = inputs.get(person.id)!;
    const efficiency = computeEfficiency(personInputs);
    return {
      staffId: person.id,
      fullName: person.full_name,
      jobTitle: person.job_title,
      department: person.department,
      goalProgress:
        personInputs.goalProgress === null ? null : Math.round(personInputs.goalProgress),
      score: efficiency.score,
      partial: efficiency.partial,
      capacity: capacityOf(
        capacityGoals.filter((row) => row.staff_id === person.id),
        daysBetween(person.start_date, today)
      ),
    };
  });
  const withGoals = list.filter((person) => person.goalProgress !== null);
  return {
    quarter: quarter.key,
    goal: goal ? toGoalView(goal) : null,
    revenuePercent: goal ? Math.round((goal.revenueSoFar / goal.revenueGoal) * 100) : null,
    teamProgress:
      withGoals.length > 0
        ? Math.round(
            withGoals.reduce((sum, person) => sum + person.goalProgress!, 0) / withGoals.length
          )
        : null,
    people: list,
    truncated: rows.length > MAX_PEOPLE,
  };
};

export const saveQuarterGoal = async (
  actor: User,
  organizationId: string,
  input: {
    quarter: string;
    currency: string;
    revenueGoal: number;
    revenueSoFar: number;
    version: number | null;
  }
): Promise<QuarterGoalView> => {
  await assertCanManagePeople(actor.id, organizationId);
  const stale = () =>
    new ConflictError("Someone changed this goal after you opened it. Reload and try again.");
  const { version, ...fields } = input;
  const existing = await goalsRepo().findOne({
    where: { organizationId, quarter: input.quarter },
  });
  if (
    existing &&
    existing.currency === input.currency &&
    existing.revenueGoal === input.revenueGoal &&
    existing.revenueSoFar === input.revenueSoFar
  ) {
    return toGoalView(existing);
  }
  if ((existing?.version ?? null) !== version) {
    throw stale();
  }
  const change = { ...fields, updatedByName: fullNameOf(actor), updatedAt: new Date() };
  if (!existing) {
    try {
      return toGoalView(await goalsRepo().save(goalsRepo().create({ organizationId, ...change })));
    } catch (err) {
      if (isUniqueViolation(err)) throw stale();
      throw err;
    }
  }
  const saved = await goalsRepo()
    .createQueryBuilder()
    .update(CompanyQuarterGoal)
    .set({ ...change, version: existing.version + 1 })
    .where(`"id" = :id AND "version" = :version`, { id: existing.id, version: existing.version })
    .execute();
  if (!saved.affected) {
    throw stale();
  }
  return toGoalView(Object.assign(existing, change, { version: existing.version + 1 }));
};
