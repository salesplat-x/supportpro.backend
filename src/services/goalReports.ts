import { EntityManager } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { StaffActivityType } from "../entities/StaffActivity.js";
import { GoalStatus, StaffGoal } from "../entities/StaffGoal.js";
import { StaffGoalReport } from "../entities/StaffGoalReport.js";
import type { StaffMember } from "../entities/StaffMember.js";
import type { User } from "../entities/User.js";
import { ConflictError, NotFoundError, ValidationError } from "../utils/errors";
import {
  deleteSpacesObjectQuietly,
  getFromSpaces,
  uploadPrivateToSpaces,
} from "../utils/integrations/spaces.js";
import {
  type ReportFrequency,
  firstPeriodFrom,
  isAlignedPeriod,
  isPeriodOpen,
  nextPeriodStart,
  periodStartOf,
  workToday,
} from "../utils/workCalendar.js";
import {
  MAX_EVIDENCE_FILES,
  MAX_EVIDENCE_LINKS,
  cleanLinks,
  prepareFiles,
} from "./completionRequests.js";
import { reportingStart } from "./efficiency.js";
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
import { fullNameOf, isUniqueViolation } from "./staffRecord.js";

export const MAX_GOAL_REPORT_TEXT = 4000;
export const MAX_GOAL_REPORT_NOTE = 2000;
const MAX_PERIODS_SHOWN = 60;

export type PeriodState = "submitted" | "missed" | "open";

export interface GoalReportView {
  id: string;
  periodStart: string;
  frequency: ReportFrequency;
  text: string | null;
  links: string[];
  files: Array<{ id: string; name: string; mimeType: string; size: number }>;
  textVersion: number;
  submittedAt: Date;
  reviewerNote: string | null;
  reviewerNoteByName: string | null;
  reviewerNoteAt: Date | null;
  noteVersion: number;
}

export interface GoalReportsView {
  goalId: string;
  frequency: ReportFrequency | null;
  /** `open` says whether a report can still be sent or changed for that period. */
  periods: Array<{
    periodStart: string;
    state: PeriodState;
    open: boolean;
    report: GoalReportView | null;
  }>;
  submitted: number;
  missed: number;
}

const reportsRepo = (em: EntityManager = AppDataSource.manager) =>
  em.getRepository(StaffGoalReport);

const toReportView = (report: StaffGoalReport): GoalReportView => ({
  id: report.id,
  periodStart: report.periodStart,
  frequency: report.frequency,
  text: report.text,
  links: report.links,
  // The storage key stays on the server, so nobody can try to reach the file directly.
  files: report.files.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })),
  textVersion: report.textVersion,
  submittedAt: report.submittedAt,
  reviewerNote: report.reviewerNote,
  reviewerNoteByName: report.reviewerNoteByName,
  reviewerNoteAt: report.reviewerNoteAt,
  noteVersion: report.noteVersion,
});

const dateOf = (value: Date | null): string | null => (value ? workToday(value) : null);

/**
 * The periods this goal expects a report for: from the latest of approval, the day the
 * frequency was set and the day the person could first report, to the earliest of today, the
 * due date and completion.
 */
const expectedPeriods = (goal: StaffGoal, staff: StaffMember, today: string): string[] => {
  const frequency = goal.reportFrequency;
  const from = reportingStart(staff);
  if (!frequency || goal.status !== GoalStatus.Approved || !from) return [];
  const starts = [dateOf(goal.approvedAt), goal.reportFrequencySince, from].filter(
    (date): date is string => !!date
  );
  const first = firstPeriodFrom(frequency, starts.sort().at(-1)!);
  const ends = [today, goal.dueOn, dateOf(goal.completedAt)].filter(
    (date): date is string => !!date
  );
  const last = periodStartOf(frequency, ends.sort()[0]!);
  const periods: string[] = [];
  for (let period = first; period <= last; period = nextPeriodStart(frequency, period)) {
    periods.push(period);
  }
  return periods;
};

const buildView = (
  goal: StaffGoal,
  staff: StaffMember,
  reports: StaffGoalReport[]
): GoalReportsView => {
  const today = workToday();
  const byPeriod = new Map(reports.map((report) => [report.periodStart, report]));
  const expected = expectedPeriods(goal, staff, today);
  const periods = [...new Set([...expected, ...byPeriod.keys()])]
    .sort()
    .reverse()
    .map((periodStart) => {
      const report = byPeriod.get(periodStart);
      const open =
        !!goal.reportFrequency &&
        !goal.completedAt &&
        expected.includes(periodStart) &&
        isPeriodOpen(goal.reportFrequency, periodStart, today);
      const state: PeriodState = report ? "submitted" : open ? "open" : "missed";
      return { periodStart, state, open, report: report ? toReportView(report) : null };
    });
  return {
    goalId: goal.id,
    frequency: goal.reportFrequency,
    periods: periods.slice(0, MAX_PERIODS_SHOWN),
    submitted: reports.length,
    missed: periods.filter((period) => period.state === "missed").length,
  };
};

const findGoal = async (staffId: string, goalId: string): Promise<StaffGoal> => {
  const goal = await AppDataSource.getRepository(StaffGoal).findOne({
    where: { id: goalId, staffId },
  });
  if (!goal) {
    throw new NotFoundError("Goal not found");
  }
  return goal;
};

const loadReports = (goalId: string) =>
  reportsRepo().find({ where: { goalId }, order: { periodStart: "DESC" } });

export const listGoalReports = async (
  scope: PerformanceScope,
  goalId: string,
  ip: string
): Promise<GoalReportsView> => {
  const staff = await openPerformance(scope, ip);
  const goal = await findGoal(staff.id, goalId);
  return buildView(goal, staff, await loadReports(goal.id));
};

export const listMyGoalReports = async (
  actor: User,
  staffId: string,
  goalId: string,
  ip: string
): Promise<GoalReportsView> => {
  const staff = await findOwnStaff(actor.id, staffId);
  await logPerformanceRead(actor, staff, ip);
  const goal = await findGoal(staff.id, goalId);
  if (goal.status !== GoalStatus.Approved) {
    throw new NotFoundError("Goal not found");
  }
  return buildView(goal, staff, await loadReports(goal.id));
};

export interface GoalReportInput {
  text: string | null;
  links: string[];
  keepFileIds: string[];
}

/**
 * The employee sends, or replaces, their report for one period. Replacing is allowed until a
 * reviewer replies. New files are uploaded before the transaction and removed if it fails;
 * files the report no longer keeps are removed after it commits.
 */
export const submitGoalReport = async (
  actor: User,
  staffId: string,
  goalId: string,
  periodStart: string,
  input: GoalReportInput,
  uploads: Express.Multer.File[]
): Promise<GoalReportView> => {
  const text = input.text?.trim() || null;
  const links = cleanLinks(input.links);
  if (links.length > MAX_EVIDENCE_LINKS) {
    throw new ValidationError(`Add at most ${MAX_EVIDENCE_LINKS} links`);
  }
  if (uploads.length > MAX_EVIDENCE_FILES) {
    throw new ValidationError(`Add at most ${MAX_EVIDENCE_FILES} files`);
  }

  const owned = await findOwnStaff(actor.id, staffId);
  const prepared = prepareFiles(uploads, owned.organizationId, "goal-reports");
  await Promise.all(
    prepared.map(({ buffer, meta }) => uploadPrivateToSpaces(buffer, meta.key, meta.mimeType))
  );

  try {
    const { view, dropped } = await AppDataSource.transaction(async (em) => {
      const staff = await lockOwnStaff(actor.id, staffId, em);
      const goal = await em.getRepository(StaffGoal).findOne({
        where: { id: goalId, staffId: staff.id },
        lock: { mode: "pessimistic_write" },
      });
      if (!goal || goal.status !== GoalStatus.Approved) {
        throw new NotFoundError("Goal not found");
      }
      if (goal.completedAt) {
        throw new ConflictError("This goal is complete, so it takes no more reports");
      }
      const frequency = goal.reportFrequency;
      if (!frequency) {
        throw new ConflictError("This goal doesn't ask for reports");
      }
      if (!isAlignedPeriod(frequency, periodStart)) {
        throw new ValidationError(`That date doesn't start a ${frequency} report period`);
      }
      if (!expectedPeriods(goal, staff, workToday()).includes(periodStart)) {
        throw new ValidationError("This goal doesn't take a report for that period");
      }
      if (!isPeriodOpen(frequency, periodStart, workToday())) {
        throw new ConflictError("That report period has closed");
      }

      const repo = reportsRepo(em);
      const existing = await repo.findOne({ where: { goalId: goal.id, periodStart } });
      if (existing?.reviewerNote) {
        throw new ConflictError("Your reviewer has already replied, so this report can't change");
      }
      const kept = (existing?.files ?? []).filter((file) => input.keepFileIds.includes(file.id));
      const files = [...kept, ...prepared.map(({ meta }) => meta)];
      if (files.length > MAX_EVIDENCE_FILES) {
        throw new ValidationError(`A report can have at most ${MAX_EVIDENCE_FILES} files`);
      }
      if (!text && links.length === 0 && files.length === 0) {
        throw new ValidationError("Write something, add a link or attach a file");
      }

      const previousFiles = existing?.files ?? [];
      const content = { text, links, files, frequency, submittedAt: new Date() };
      const saved = existing
        ? await repo.save(
            Object.assign(existing, content, { textVersion: existing.textVersion + 1 })
          )
        : await repo.save(
            repo.create({
              ...content,
              organizationId: staff.organizationId,
              staffId: staff.id,
              goalId: goal.id,
              periodStart,
            })
          );
      await recordActivities(em, staff, [
        activityEntry(StaffActivityType.GoalReportSubmitted, actor, {
          title: goal.title,
          periodStart,
        }),
      ]);
      const keptIds = new Set(kept.map((file) => file.id));
      return {
        view: toReportView(saved),
        dropped: previousFiles.filter((file) => !keptIds.has(file.id)),
      };
    });
    await Promise.all(
      dropped.map((file) => deleteSpacesObjectQuietly(file.key, "replaced goal report file"))
    );
    return view;
  } catch (err) {
    await Promise.all(
      prepared.map(({ meta }) => deleteSpacesObjectQuietly(meta.key, "unsaved goal report file"))
    );
    if (isUniqueViolation(err)) {
      throw new ConflictError(
        "This report was just sent from somewhere else. Reload and try again."
      );
    }
    throw err;
  }
};

/** Sends the versions the reviewer read, so a note can't land on a report they never saw. */
export const addGoalReportNote = async (
  scope: PerformanceScope,
  goalId: string,
  reportId: string,
  note: string,
  textVersion: number,
  noteVersion: number
): Promise<GoalReportView> => {
  await assertScope(scope);
  return AppDataSource.transaction(async (em) => {
    const staff = await lockScopedStaff(scope, em);
    const repo = reportsRepo(em);
    const report = await repo.findOne({ where: { id: reportId, goalId, staffId: staff.id } });
    if (!report) {
      throw new NotFoundError("Report not found");
    }
    if (report.textVersion !== textVersion || report.noteVersion !== noteVersion) {
      throw new ConflictError("This report changed after you opened it. Reload and try again.");
    }
    const changes = {
      reviewerNote: note,
      reviewerNoteByName: fullNameOf(scope.actor),
      reviewerNoteAt: new Date(),
      noteVersion: report.noteVersion + 1,
    };
    await repo.update(report.id, changes);
    await recordActivities(em, staff, [
      activityEntry(StaffActivityType.GoalReportNoteAdded, scope.actor, {
        periodStart: report.periodStart,
      }),
    ]);
    return toReportView(Object.assign(report, changes));
  });
};

interface ReportFile {
  fileName: string;
  contentType: string;
  file: Buffer;
}

const readReportFile = async (
  staffId: string,
  goalId: string,
  reportId: string,
  fileId: string
): Promise<ReportFile> => {
  const report = await reportsRepo().findOne({ where: { id: reportId, goalId, staffId } });
  const stored = report?.files.find((file) => file.id === fileId);
  if (!stored) {
    throw new NotFoundError("File not found");
  }
  return {
    fileName: stored.name,
    contentType: stored.mimeType,
    file: await getFromSpaces(stored.key),
  };
};

export const downloadGoalReportFile = async (
  scope: PerformanceScope,
  goalId: string,
  reportId: string,
  fileId: string,
  ip: string
): Promise<ReportFile> => {
  const staff = await openPerformance(scope, ip);
  return readReportFile(staff.id, goalId, reportId, fileId);
};

export const downloadMyGoalReportFile = async (
  actor: User,
  staffId: string,
  goalId: string,
  reportId: string,
  fileId: string,
  ip: string
): Promise<ReportFile> => {
  const staff = await findOwnStaff(actor.id, staffId);
  await logPerformanceRead(actor, staff, ip);
  return readReportFile(staff.id, goalId, reportId, fileId);
};
