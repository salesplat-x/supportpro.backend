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
