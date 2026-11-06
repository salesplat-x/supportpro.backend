import { AppDataSource } from "../database/dataSource.js";
import { StaffActivityType } from "../entities/StaffActivity.js";
import { StaffMonthlyFeedback } from "../entities/StaffMonthlyFeedback.js";
import { ConflictError } from "../utils/errors";
import { monthStartOf, workToday } from "../utils/workCalendar.js";
import { type PerformanceScope, assertScope, lockScopedStaff } from "./performanceAccess.js";
import { activityEntry, recordActivities } from "./staffAudit.js";
import { fullNameOf } from "./staffRecord.js";

export const MAX_FEEDBACK_NOTES = 2000;
const MONTHS_ON_TAB = 24;

export interface FeedbackView {
  id: string;
  month: string;
  rating: number;
  notes: string;
  byName: string;
  version: number;
  updatedAt: Date;
}

const repo = () => AppDataSource.getRepository(StaffMonthlyFeedback);

const toView = (row: StaffMonthlyFeedback): FeedbackView => ({
  id: row.id,
  month: row.month.slice(0, 7),
  rating: row.rating,
  notes: row.notes,
  byName: row.byName,
  version: row.version,
  updatedAt: row.updatedAt,
});

/** Oldest first, ready for the trend chart. */
export const listFeedback = async (staffId: string): Promise<FeedbackView[]> => {
  const rows = await repo().find({
    where: { staffId },
    order: { month: "DESC" },
    take: MONTHS_ON_TAB,
  });
  return rows.reverse().map(toView);
};

/** `version` is null for a first save. An identical retry succeeds; anything else stale is refused. */
export const saveFeedback = async (
  scope: PerformanceScope,
  month: string,
  input: { rating: number; notes: string },
  version: number | null
): Promise<FeedbackView> => {
  await assertScope(scope);
  return AppDataSource.transaction(async (em) => {
    const staff = await lockScopedStaff(scope, em);
    const firstDay = `${month}-01`;
    if (firstDay > monthStartOf(workToday())) {
      throw new ConflictError("You can't give feedback for a month that hasn't started");
    }
    if (firstDay < monthStartOf(staff.startDate)) {
      throw new ConflictError("This month is before this person's start date");
    }
    const feedback = em.getRepository(StaffMonthlyFeedback);
    const existing = await feedback.findOne({ where: { staffId: staff.id, month: firstDay } });
    if (existing && existing.rating === input.rating && existing.notes === input.notes) {
      return toView(existing);
    }
    if ((existing?.version ?? null) !== version) {
      throw new ConflictError("This feedback changed after you opened it. Reload and try again.");
    }
    const saved = await feedback.save(
      Object.assign(
        existing ??
          feedback.create({
            organizationId: staff.organizationId,
            staffId: staff.id,
            month: firstDay,
          }),
        {
          ...input,
          byName: fullNameOf(scope.actor),
          version: (existing?.version ?? 0) + 1,
          updatedAt: new Date(),
        }
      )
    );
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.FeedbackSaved, scope.actor, { month }),
    ]);
    return toView(saved);
  });
};
