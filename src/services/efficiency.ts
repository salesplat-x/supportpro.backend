import crypto from "crypto";
import { AppDataSource } from "../database/dataSource.js";
import { StaffEfficiencyTip } from "../entities/StaffEfficiencyTip.js";
import { AuthorizationError, ConflictError } from "../utils/errors";
import { efficiencyTip as efficiencyTipAI } from "../utils/integrations/openai.js";
import {
  type Quarter,
  addDays,
  daysBetween,
  quarterOf,
  weekStartOf,
  workToday,
} from "../utils/workCalendar.js";
import { aiFailure, askAi, cleanAiText, withAiClaim } from "./peopleAi.js";
import {
  type PerformanceScope,
  assertScope,
  assertWritable,
  openPerformance,
} from "./performanceAccess.js";

/** The formula the owner confirmed. */
export const EFFICIENCY_WEIGHTS = { goals: 0.5, reports: 0.25, rating: 0.25 } as const;

const MAX_RATING = 5;
const MAX_TIP_LENGTH = 600;

export type EfficiencyPartKey = keyof typeof EFFICIENCY_WEIGHTS;

export interface EfficiencyInputs {
  goalProgress: number | null;
  reportRate: number | null;
  ratingAverage: number | null;
}

export interface EfficiencyView {
  score: number | null;
  partial: boolean;
  parts: Array<{ key: EfficiencyPartKey; weight: number; value: number | null }>;
}

/** A missing part is left out and the other weights scale up, so new hires aren't scored on nothing. */
export const computeEfficiency = (inputs: EfficiencyInputs): EfficiencyView => {
  const parts: EfficiencyView["parts"] = [
    { key: "goals", weight: EFFICIENCY_WEIGHTS.goals, value: inputs.goalProgress },
    { key: "reports", weight: EFFICIENCY_WEIGHTS.reports, value: inputs.reportRate },
    {
      key: "rating",
      weight: EFFICIENCY_WEIGHTS.rating,
      value: inputs.ratingAverage === null ? null : (inputs.ratingAverage / MAX_RATING) * 100,
    },
  ];
  const known = parts.filter((part) => part.value !== null);
  if (known.length === 0) {
    return { score: null, partial: true, parts };
  }
  const totalWeight = known.reduce((sum, part) => sum + part.weight, 0);
  const weighted = known.reduce((sum, part) => sum + part.value! * part.weight, 0);
  return {
    score: Math.round(weighted / totalWeight),
    partial: known.length < parts.length,
    parts,
  };
};

/**
 * Weeks a person could have reported in this quarter: from their start week, or the first
 * week whose Monday is in the quarter, up to the last finished one. The current week joins
 * only once it is submitted, so nobody is marked down for a week that isn't over.
 */
export const reportWeeksIn = (
  startDate: string,
  quarter: Quarter,
  today: string
): { first: string; lastFinished: string; current: string | null } => {
  const startMonday = weekStartOf(quarter.start);
  const firstInQuarter = startMonday === quarter.start ? startMonday : addDays(startMonday, 7);
  const startWeek = weekStartOf(startDate);
  const first = startWeek > firstInQuarter ? startWeek : firstInQuarter;
  if (today > quarter.end) {
    return { first, lastFinished: weekStartOf(quarter.end), current: null };
  }
  const current = weekStartOf(today);
  return { first, lastFinished: addDays(current, -7), current };
};

export const reportRateFrom = (
  submittedWeeks: string[],
  startDate: string,
  quarter: Quarter,
  today: string
): number | null => {
  const { first, lastFinished, current } = reportWeeksIn(startDate, quarter, today);
  const finished = lastFinished < first ? 0 : daysBetween(first, lastFinished) / 7 + 1;
  const inRange = submittedWeeks.filter((week) => week >= first);
  const currentCounts = !!current && current >= first && inRange.includes(current);
  const eligible = finished + (currentCounts ? 1 : 0);
  if (eligible === 0) {
    return null;
  }
  const submitted = inRange.filter((week) => week <= lastFinished || week === current).length;
  return Math.min(100, (submitted / eligible) * 100);
};

export interface EfficiencyPerson {
  id: string;
  startDate: string;
  userId: string | null;
  joinedAt: Date | null;
}

/**
 * Someone with no AuxHR account can't submit a report, so they have no rate rather than 0%.
 * Weeks count from when they could first submit: their start date or the day they joined.
 */
export const reportingStart = (person: EfficiencyPerson): string | null => {
  if (!person.userId) return null;
  const joined = person.joinedAt ? workToday(new Date(person.joinedAt)) : null;
  return joined && joined > person.startDate ? joined : person.startDate;
};

export const loadEfficiencyInputs = async (
  people: EfficiencyPerson[],
  quarter: Quarter,
  today: string
): Promise<Map<string, EfficiencyInputs>> => {
  const ids = people.map((person) => person.id);
  const [goals, reports, ratings]: [
    Array<{ staff_id: string; average: string }>,
    Array<{ staff_id: string; week: string }>,
    Array<{ staff_id: string; average: string }>,
  ] = await Promise.all([
    AppDataSource.query(
      `SELECT staff_id, AVG(progress) AS average FROM staff_goals
       WHERE staff_id = ANY($1::uuid[]) AND status = 'approved'
         AND (progress < 100 OR due_on BETWEEN $2 AND $3)
       GROUP BY staff_id`,
      [ids, quarter.start, quarter.end]
    ),
    AppDataSource.query(
      `SELECT staff_id, to_char(week_start, 'YYYY-MM-DD') AS week FROM staff_weekly_reports
       WHERE staff_id = ANY($1::uuid[]) AND week_start BETWEEN $2 AND $3`,
      [ids, quarter.start, quarter.end]
    ),
    AppDataSource.query(
      `SELECT staff_id, AVG(rating) AS average FROM staff_monthly_feedback
       WHERE staff_id = ANY($1::uuid[]) AND month BETWEEN $2 AND $3
       GROUP BY staff_id`,
      [ids, quarter.start, quarter.end]
    ),
  ]);
  const averageOf = (rows: Array<{ staff_id: string; average: string }>) =>
    new Map(rows.map((row) => [row.staff_id, Number(row.average)]));
  const goalAverages = averageOf(goals);
  const ratingAverages = averageOf(ratings);
  return new Map(
    people.map((person) => {
      const reportingFrom = reportingStart(person);
      return [
        person.id,
        {
          goalProgress: goalAverages.get(person.id) ?? null,
          ratingAverage: ratingAverages.get(person.id) ?? null,
          reportRate: reportingFrom
            ? reportRateFrom(
                reports.filter((row) => row.staff_id === person.id).map((row) => row.week),
                reportingFrom,
                quarter,
                today
              )
            : null,
        },
      ];
    })
  );
};

export const efficiencyFor = async (
  person: EfficiencyPerson
): Promise<EfficiencyView & { quarter: string }> => {
  const today = workToday();
  const quarter = quarterOf(today);
  const inputs = await loadEfficiencyInputs([person], quarter, today);
  return { ...computeEfficiency(inputs.get(person.id)!), quarter: quarter.key };
};

const fingerprint = (view: EfficiencyView & { quarter: string }): string =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify([view.quarter, view.score, view.parts]))
    .digest("hex");

export interface EfficiencyTipView {
  tip: string;
  current: boolean;
}

/** `current` is false once the numbers have moved on, which is when a new tip is worth offering. */
export const loadEfficiencyTip = async (
  staffId: string,
  view: EfficiencyView & { quarter: string }
): Promise<EfficiencyTipView | null> => {
  const saved = await AppDataSource.getRepository(StaffEfficiencyTip).findOne({
    where: { staffId },
  });
  return saved ? { tip: saved.tip, current: saved.inputsHash === fingerprint(view) } : null;
};

export const requestEfficiencyTip = async (
  scope: PerformanceScope,
  ip: string
): Promise<EfficiencyTipView> => {
  await assertScope(scope);
  const staff = await openPerformance(scope, ip);
  assertWritable(staff);
  if (staff.isExecutive) {
    throw new AuthorizationError("Tips are not offered for this role");
  }
  const repo = AppDataSource.getRepository(StaffEfficiencyTip);
  const view = await efficiencyFor(staff);
  if (view.score === null) {
    throw new ConflictError("There isn't enough data for a score yet");
  }
  const hash = fingerprint(view);
  const existing = await repo.findOne({ where: { staffId: staff.id } });
  if (existing?.inputsHash === hash) {
    return { tip: existing.tip, current: true };
  }
  return withAiClaim(`efficiency-tip:${staff.id}`, async () => {
    const finished = await repo.findOne({ where: { staffId: staff.id } });
    if (finished?.inputsHash === hash) {
      return { tip: finished.tip, current: true };
    }
    const reply = await askAi(() =>
      efficiencyTipAI({
        jobTitle: staff.jobTitle,
        score: view.score!,
        parts: view.parts.map(({ key, value }) => ({ key, value })),
      })
    );
    const tip = cleanAiText(reply["tip"], MAX_TIP_LENGTH);
    if (!tip) {
      throw aiFailure();
    }
    await repo.save(
      repo.create({ staffId: staff.id, inputsHash: hash, tip, updatedAt: new Date() })
    );
    return { tip, current: true };
  });
};
