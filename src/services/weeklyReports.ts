import { In } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { GoalStatus, StaffGoal } from "../entities/StaffGoal.js";
import { StaffActivityType } from "../entities/StaffActivity.js";
import { StaffWeeklyReport } from "../entities/StaffWeeklyReport.js";
import type { User } from "../entities/User.js";
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from "../utils/errors";
import { weeklyAdvice as weeklyAdviceAI } from "../utils/integrations/openai.js";
import { addDays, isWeekOpen, weekStartOf, workToday } from "../utils/workCalendar.js";
import { aiFailure, askAi, cleanAiText, withAiClaim } from "./peopleAi.js";
import {
  type PerformanceScope,
  assertScope,
  findOwnStaff,
  lockOwnStaff,
  lockScopedStaff,
  logPerformanceRead,
  openPerformance,
} from "./performanceAccess.js";
import { activityEntry, recordActivities } from "./staffAudit.js";
import { fullNameOf } from "./staffRecord.js";

export const MAX_REPORT_FIELD = 5000;
export const MAX_NOTE = 2000;
const MIN_TIPS = 3;
const MAX_TIPS = 5;
const MAX_TIP_LENGTH = 500;
const MAX_TEAM = 500;

export interface ReportText {
  did: string;
  blocked: string;
  nextWeek: string;
}

export interface ReportView extends ReportText {
  id: string;
  weekStart: string;
  textVersion: number;
  submittedAt: Date;
  managerNote: string | null;
  managerNoteByName: string | null;
  managerNoteAt: Date | null;
  noteVersion: number;
  advice: string[] | null;
  adviceAt: Date | null;
}

export interface TeamMemberView {
  staffId: string;
  fullName: string;
  jobTitle: string;
  reportId: string | null;
  goalsWaiting: number;
  /** Why they're on this team: they report to this person, they're in a department this person heads, or both. */
  relation: "report" | "department" | "both";
  departmentName: string | null;
  /** Goal reports from the last 30 days that nobody has replied to yet. */
  goalReportsToRead: number;
}

const reportsRepo = (em = AppDataSource.manager) => em.getRepository(StaffWeeklyReport);

export const toReportView = (report: StaffWeeklyReport): ReportView => ({
  id: report.id,
  weekStart: report.weekStart,
  did: report.did,
  blocked: report.blocked,
  nextWeek: report.nextWeek,
  textVersion: report.textVersion,
  submittedAt: report.submittedAt,
  managerNote: report.managerNote,
  managerNoteByName: report.managerNoteByName,
  managerNoteAt: report.managerNoteAt,
  noteVersion: report.noteVersion,
  advice: report.advice,
  adviceAt: report.adviceAt,
});

export const listReportsFor = async (
  staffId: string,
  limit: number,
  offset: number
): Promise<{ items: ReportView[]; total: number }> => {
  const [rows, total] = await reportsRepo().findAndCount({
    where: { staffId },
    order: { weekStart: "DESC" },
    take: limit,
    skip: offset,
  });
  return { items: rows.map(toReportView), total };
};

export interface ReportWeekView {
  weekStart: string;
  state: "submitted" | "not_yet";
  report: ReportView | null;
}

/** Every working week from the current one back to the start week, so a missed week shows as Not yet. */
export const listWeeksFor = async (
  staff: { id: string; startDate: string },
  limit: number
): Promise<ReportWeekView[]> => {
  const current = weekStartOf(workToday());
  const startWeek = weekStartOf(staff.startDate);
  const weeks: string[] = [];
  for (let week = current; week >= startWeek && weeks.length < limit; week = addDays(week, -7)) {
    weeks.push(week);
  }
  if (weeks.length === 0) return [];
  const rows = await reportsRepo().find({
    where: { staffId: staff.id, weekStart: In(weeks) },
  });
  const byWeek = new Map(rows.map((row) => [row.weekStart, toReportView(row)]));
  return weeks.map((weekStart) => {
    const report = byWeek.get(weekStart) ?? null;
    return { weekStart, state: report ? "submitted" : "not_yet", report };
  });
};

export const listReports = async (
  scope: PerformanceScope,
  limit: number,
  offset: number,
  ip: string
) => {
  const staff = await openPerformance(scope, ip);
  return listReportsFor(staff.id, limit, offset);
};

export const listMyReports = async (
  actor: User,
  staffId: string,
  limit: number,
  offset: number,
  ip: string
) => {
  const staff = await findOwnStaff(actor.id, staffId);
  await logPerformanceRead(actor, staff, ip);
  return listReportsFor(staff.id, limit, offset);
};

/** The staff row's lock settles a double submit, and the unique index backs it up. */
export const submitReport = async (
  actor: User,
  staffId: string,
  weekStart: string,
  text: ReportText
): Promise<ReportView> =>
  AppDataSource.transaction(async (em) => {
    const staff = await lockOwnStaff(actor.id, staffId, em);
    if (weekStartOf(weekStart) !== weekStart) {
      throw new ValidationError("A report's week must start on a Monday");
    }
    if (!isWeekOpen(weekStart, workToday())) {
      throw new ConflictError("Reports for this week are closed");
    }
    if (addDays(weekStart, 6) < staff.startDate) {
      throw new ConflictError("This week is before your start date");
    }
    const repo = reportsRepo(em);
    const existing = await repo.findOne({ where: { staffId, weekStart } });
    if (!existing) {
      const created = await repo.save(
        repo.create({
          ...text,
          organizationId: staff.organizationId,
          staffId,
          weekStart,
          submittedAt: new Date(),
        })
      );
      await recordActivities(em, staff, [
        activityEntry(StaffActivityType.WeeklyReportSubmitted, actor, { weekStart }),
      ]);
      return toReportView(created);
    }
    const unchanged =
      existing.did === text.did &&
      existing.blocked === text.blocked &&
      existing.nextWeek === text.nextWeek;
    if (unchanged) {
      return toReportView(existing);
    }
    if (existing.managerNote) {
      throw new ConflictError("Your manager has already added a note to this report");
    }
    const changes = {
      ...text,
      textVersion: existing.textVersion + 1,
      submittedAt: new Date(),
      advice: null,
      adviceAt: null,
    };
    await repo.update(existing.id, changes);
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.WeeklyReportSubmitted, actor, { weekStart }),
    ]);
    return toReportView(Object.assign(existing, changes));
  });

/** Sends the versions the writer read, so a note can't land on text they never saw. */
export const addReportNote = async (
  scope: PerformanceScope,
  reportId: string,
  note: string,
  textVersion: number,
  noteVersion: number
): Promise<ReportView> => {
  await assertScope(scope);
  return AppDataSource.transaction(async (em) => {
    const staff = await lockScopedStaff(scope, em);
    const repo = reportsRepo(em);
    const report = await repo.findOne({ where: { id: reportId, staffId: staff.id } });
    if (!report) {
      throw new NotFoundError("Report not found");
    }
    if (report.textVersion !== textVersion || report.noteVersion !== noteVersion) {
      throw new ConflictError("This report changed after you opened it. Reload and try again.");
    }
    const changes = {
      managerNote: note,
      managerNoteByName: fullNameOf(scope.actor),
      managerNoteAt: new Date(),
      noteVersion: report.noteVersion + 1,
    };
    await repo.update(report.id, changes);
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.ReportNoteAdded, scope.actor, {
        weekStart: report.weekStart,
      }),
    ]);
    return toReportView(Object.assign(report, changes));
  });
};

const cleanTips = (reply: Record<string, unknown>): string[] => {
  const raw = Array.isArray(reply["tips"]) ? (reply["tips"] as unknown[]) : [];
  const tips = raw
    .map((tip) => cleanAiText(tip, MAX_TIP_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_TIPS);
  if (tips.length < MIN_TIPS) {
    throw aiFailure();
  }
  return tips;
};

const textOf = (report: StaffWeeklyReport): ReportText => ({
  did: report.did,
  blocked: report.blocked,
  nextWeek: report.nextWeek,
});

/** Saved advice is returned for free. A report edited during the call keeps no advice about old text. */
export const requestAdvice = async (
  actor: User,
  staffId: string,
  reportId: string,
  ip: string
): Promise<ReportView> => {
  const staff = await findOwnStaff(actor.id, staffId);
  if (staff.isExecutive) {
    throw new AuthorizationError("Advice is not offered for this role");
  }
  const findReport = async () => {
    const found = await reportsRepo().findOne({ where: { id: reportId, staffId } });
    if (!found) {
      throw new NotFoundError("Report not found");
    }
    return found;
  };
  const report = await findReport();
  if (report.advice) {
    return toReportView(report);
  }
  await logPerformanceRead(actor, staff, ip);

  return withAiClaim(`advice:${report.id}`, async () => {
    const current = await findReport();
    if (current.advice) {
      return toReportView(current);
    }
    const [previous, goals] = await Promise.all([
      reportsRepo().findOne({ where: { staffId, weekStart: addDays(current.weekStart, -7) } }),
      AppDataSource.getRepository(StaffGoal).find({
        where: { staffId, status: GoalStatus.Approved },
        select: { id: true, title: true, progress: true, dueOn: true },
      }),
    ]);
    const tips = cleanTips(
      await askAi(() =>
        weeklyAdviceAI({
          thisWeek: textOf(current),
          lastWeek: previous ? textOf(previous) : null,
          goals: goals.map(({ title, progress, dueOn }) => ({ title, progress, dueOn })),
        })
      )
    );
    const adviceAt = new Date();
    const saved = await reportsRepo()
      .createQueryBuilder()
      .update(StaffWeeklyReport)
      .set({ advice: tips, adviceAt })
      .where(`"id" = :id AND "text_version" = :version`, {
        id: current.id,
        version: current.textVersion,
      })
      .execute();
    if (!saved.affected) {
      throw new ConflictError("Your report changed while this was running. Ask for advice again.");
    }
    return toReportView(Object.assign(current, { advice: tips, adviceAt }));
  });
};

/** One query for the whole list, so opening My team costs the same for any team size. */
export const getMyTeam = async (
  actor: User,
  managerStaffId: string,
  ip: string
): Promise<{
  weekStart: string;
  members: TeamMemberView[];
  departments: Array<{ id: string; name: string }>;
}> => {
  const manager = await findOwnStaff(actor.id, managerStaffId);
  await logPerformanceRead(
    actor,
    {
      id: null,
      fullName: `team of ${manager.fullName}`,
      organizationId: manager.organizationId,
    },
    ip
  );
  const today = workToday();
  const weekStart = weekStartOf(today);
  const rows: Array<{
    id: string;
    full_name: string;
    job_title: string;
    report_id: string | null;
    goals_waiting: number;
    goal_reports_to_read: number;
    is_report: boolean;
    in_department: boolean;
    department_name: string | null;
  }> = await AppDataSource.query(
    `SELECT s.id, s.full_name, s.job_title, r.id AS report_id, dep.name AS department_name,
            s.manager_id IS NOT DISTINCT FROM $1 AS is_report,
            dep.head_staff_id IS NOT DISTINCT FROM $1 AS in_department,
            (SELECT COUNT(*)::int FROM staff_goals g
             WHERE g.staff_id = s.id AND g.status = $4) AS goals_waiting,
            (SELECT COUNT(*)::int FROM staff_goal_reports gr
             WHERE gr.staff_id = s.id AND gr.reviewer_note IS NULL
               AND gr.submitted_at > NOW() - INTERVAL '30 days') AS goal_reports_to_read
     FROM staff_members s
     LEFT JOIN departments dep ON dep.id = s.department_id
     LEFT JOIN staff_weekly_reports r ON r.staff_id = s.id AND r.week_start = $3
     WHERE s.organization_id = $2 AND s.id <> $1
       AND (s.manager_id = $1 OR dep.head_staff_id = $1)
       AND s.end_date IS NULL AND s.start_date <= $5
     ORDER BY s.full_name, s.id
     LIMIT $6`,
    [manager.id, manager.organizationId, weekStart, GoalStatus.Draft, today, MAX_TEAM]
  );
  const departments: Array<{ id: string; name: string }> = await AppDataSource.query(
    `SELECT id, name FROM departments WHERE head_staff_id = $1 ORDER BY name`,
    [manager.id]
  );
  return {
    weekStart,
    members: rows.map((row) => ({
      staffId: row.id,
      fullName: row.full_name,
      jobTitle: row.job_title,
      reportId: row.report_id,
      goalsWaiting: row.goals_waiting,
      goalReportsToRead: row.goal_reports_to_read,
      relation: row.is_report ? (row.in_department ? "both" : "report") : "department",
      departmentName: row.department_name,
    })),
    departments,
  };
};
