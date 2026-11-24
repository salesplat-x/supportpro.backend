/** Companies have no timezone setting, so working weeks and quarters follow Lagos. */
const WORK_TIMEZONE = "Africa/Lagos";
const DAY_MS = 86_400_000;

export const workToday = (now: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: WORK_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

const toUtc = (dateOnly: string): number => Date.parse(`${dateOnly}T00:00:00Z`);

export const addDays = (dateOnly: string, days: number): string =>
  new Date(toUtc(dateOnly) + days * DAY_MS).toISOString().slice(0, 10);

export const daysBetween = (from: string, to: string): number =>
  Math.round((toUtc(to) - toUtc(from)) / DAY_MS);

export const weekStartOf = (dateOnly: string): string => {
  const weekday = new Date(toUtc(dateOnly)).getUTCDay();
  return addDays(dateOnly, -((weekday + 6) % 7));
};

/** Last week stays open through Monday, so a report retried just after Sunday midnight still lands. */
export const isWeekOpen = (weekStart: string, today: string): boolean => {
  const current = weekStartOf(today);
  return weekStart === current || (weekStart === addDays(current, -7) && today === current);
};

export const monthStartOf = (dateOnly: string): string => `${dateOnly.slice(0, 7)}-01`;

export interface Quarter {
  key: string;
  start: string;
  end: string;
}

export const quarterFromKey = (key: string): Quarter => {
  const year = Number(key.slice(0, 4));
  const number = Number(key.slice(6));
  const startMonth = (number - 1) * 3;
  return {
    key,
    start: new Date(Date.UTC(year, startMonth, 1)).toISOString().slice(0, 10),
    end: new Date(Date.UTC(year, startMonth + 3, 0)).toISOString().slice(0, 10),
  };
};

export const quarterOf = (dateOnly: string): Quarter =>
  quarterFromKey(
    `${dateOnly.slice(0, 4)}-Q${Math.floor((Number(dateOnly.slice(5, 7)) - 1) / 3) + 1}`
  );

export type ReportFrequency = "daily" | "weekly" | "monthly";
export const REPORT_FREQUENCIES: ReportFrequency[] = ["daily", "weekly", "monthly"];

/** Monday to Friday. Daily reports skip weekends. */
export const isWorkDay = (dateOnly: string): boolean => {
  const weekday = new Date(toUtc(dateOnly)).getUTCDay();
  return weekday !== 0 && weekday !== 6;
};

const workDayFrom = (dateOnly: string, step: 1 | -1): string => {
  let day = dateOnly;
  while (!isWorkDay(day)) day = addDays(day, step);
  return day;
};

const addMonths = (monthStart: string, months: number): string => {
  const year = Number(monthStart.slice(0, 4));
  const month = Number(monthStart.slice(5, 7)) - 1;
  return new Date(Date.UTC(year, month + months, 1)).toISOString().slice(0, 10);
};

/** The period a date falls in. A weekend day belongs to the Friday before it. */
export const periodStartOf = (frequency: ReportFrequency, dateOnly: string): string => {
  if (frequency === "daily") return workDayFrom(dateOnly, -1);
  return frequency === "weekly" ? weekStartOf(dateOnly) : monthStartOf(dateOnly);
};

export const isAlignedPeriod = (frequency: ReportFrequency, periodStart: string): boolean =>
  periodStartOf(frequency, periodStart) === periodStart;

export const nextPeriodStart = (frequency: ReportFrequency, periodStart: string): string => {
  if (frequency === "daily") return workDayFrom(addDays(periodStart, 1), 1);
  return frequency === "weekly" ? addDays(periodStart, 7) : addMonths(periodStart, 1);
};

/** The first period that starts on or after a date, so a goal set on a Saturday starts on Monday. */
export const firstPeriodFrom = (frequency: ReportFrequency, dateOnly: string): string => {
  const start = periodStartOf(frequency, dateOnly);
  return start === dateOnly || frequency !== "daily" ? start : nextPeriodStart(frequency, start);
};

/**
 * The current period is always open. The one before it stays open until the end of the current
 * period's first work day, so a report sent just after midnight still lands.
 */
export const isPeriodOpen = (
  frequency: ReportFrequency,
  periodStart: string,
  today: string
): boolean => {
  const current = periodStartOf(frequency, today);
  if (periodStart === current) return true;
  return nextPeriodStart(frequency, periodStart) === current && today <= workDayFrom(current, 1);
};
