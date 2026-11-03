import {
  addDays,
  daysBetween,
  isWeekOpen,
  monthStartOf,
  quarterFromKey,
  quarterOf,
  weekStartOf,
  workToday,
} from "../src/utils/workCalendar.js";

describe("work calendar", () => {
  it.each([
    ["2026-11-01T22:59:59Z", "2026-11-01"],
    ["2026-11-01T23:00:00Z", "2026-11-02"],
    ["2026-12-31T23:30:00Z", "2027-01-01"],
  ])("reads %s as %s in Lagos", (instant, expected) => {
    expect(workToday(new Date(instant))).toBe(expected);
  });

  it.each([
    ["2026-11-02", "2026-11-02"],
    ["2026-11-08", "2026-11-02"],
    ["2026-11-09", "2026-11-09"],
    ["2027-01-01", "2026-12-28"],
    ["2028-02-29", "2028-02-28"],
  ])("puts %s in the week starting %s", (day, monday) => {
    expect(weekStartOf(day)).toBe(monday);
  });

  it("keeps last week open only through Monday", () => {
    expect(isWeekOpen("2026-11-02", "2026-11-08")).toBe(true);
    expect(isWeekOpen("2026-11-02", "2026-11-09")).toBe(true);
    expect(isWeekOpen("2026-11-02", "2026-11-10")).toBe(false);
    expect(isWeekOpen("2026-11-09", "2026-11-09")).toBe(true);
    expect(isWeekOpen("2026-11-16", "2026-11-09")).toBe(false);
    expect(isWeekOpen("2026-10-26", "2026-11-09")).toBe(false);
  });

  it("finds quarters at their edges", () => {
    expect(quarterOf("2026-03-31").key).toBe("2026-Q1");
    expect(quarterOf("2026-04-01").key).toBe("2026-Q2");
    expect(quarterOf("2026-12-31").key).toBe("2026-Q4");
    expect(quarterFromKey("2028-Q1")).toEqual({
      key: "2028-Q1",
      start: "2028-01-01",
      end: "2028-03-31",
    });
    expect(quarterFromKey("2026-Q4").end).toBe("2026-12-31");
  });

  it("does plain date maths without timezones leaking in", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-11-01", "2026-11-29")).toBe(28);
    expect(monthStartOf("2026-11-29")).toBe("2026-11-01");
  });
});
