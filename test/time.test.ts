import { describe, expect, it } from "vitest";
import {
  dayOf,
  daysOf,
  isClosed,
  periodOf,
  parsePeriod,
  previousDay,
} from "../src/time/index.js";

const madrid = { timezone: "Europe/Madrid", dayBoundary: "04:00" };

describe("day boundary", () => {
  it("counts work before 04:00 toward the previous day", () => {
    expect(dayOf(new Date("2026-10-08T01:30:00+02:00"), madrid)).toBe("2026-10-07");
  });

  it("starts the new day at exactly 04:00 local", () => {
    expect(dayOf(new Date("2026-10-08T04:00:00+02:00"), madrid)).toBe("2026-10-08");
    expect(dayOf(new Date("2026-10-08T03:59:00+02:00"), madrid)).toBe("2026-10-07");
  });

  it("uses the configured time zone, not UTC", () => {
    // 23:30 UTC on the 7th is 01:30 on the 8th in Madrid, still the 7th's atlas day
    expect(dayOf(new Date("2026-10-07T23:30:00Z"), madrid)).toBe("2026-10-07");
    // 02:30 UTC on the 8th is 04:30 in Madrid, so the 8th
    expect(dayOf(new Date("2026-10-08T02:30:00Z"), madrid)).toBe("2026-10-08");
  });

  it("honours a custom boundary", () => {
    const midnight = { timezone: "Europe/Madrid", dayBoundary: "00:00" };
    expect(dayOf(new Date("2026-10-08T01:30:00+02:00"), midnight)).toBe("2026-10-08");
  });

  it("handles the day of a DST change", () => {
    // Madrid leaves summer time on 2026-10-25 at 03:00 local
    expect(dayOf(new Date("2026-10-25T03:30:00+01:00"), madrid)).toBe("2026-10-24");
    expect(dayOf(new Date("2026-10-25T04:30:00+01:00"), madrid)).toBe("2026-10-25");
  });

  it("steps back across month and year ends", () => {
    expect(previousDay("2026-03-01")).toBe("2026-02-28");
    expect(previousDay("2027-01-01")).toBe("2026-12-31");
  });
});

describe("periods", () => {
  it("names weeks with ISO week numbers", () => {
    expect(periodOf("week", "2026-10-08")).toBe("2026-W41");
    expect(periodOf("week", "2026-09-28")).toBe("2026-W40");
    expect(periodOf("week", "2026-10-04")).toBe("2026-W40");
  });

  it("uses the ISO week-numbering year at year ends", () => {
    expect(periodOf("week", "2025-12-29")).toBe("2026-W01");
    expect(periodOf("week", "2026-12-31")).toBe("2026-W53");
    expect(periodOf("week", "2027-01-03")).toBe("2026-W53");
    expect(periodOf("week", "2027-01-04")).toBe("2027-W01");
  });

  it("names days, months and years by the calendar", () => {
    expect(periodOf("day", "2026-10-08")).toBe("2026-10-08");
    expect(periodOf("month", "2026-10-08")).toBe("2026-10");
    expect(periodOf("year", "2026-10-08")).toBe("2026");
  });

  it("parses a period id back to its layer", () => {
    expect(parsePeriod("2026-10-08")).toEqual({ layer: "day", id: "2026-10-08" });
    expect(parsePeriod("2026-W41")).toEqual({ layer: "week", id: "2026-W41" });
    expect(parsePeriod("2026-10")).toEqual({ layer: "month", id: "2026-10" });
    expect(parsePeriod("2026")).toEqual({ layer: "year", id: "2026" });
    expect(() => parsePeriod("last tuesday")).toThrow();
  });

  it("lists the days in a period", () => {
    expect(daysOf("2026-W41")).toEqual([
      "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08",
      "2026-10-09", "2026-10-10", "2026-10-11",
    ]);
    expect(daysOf("2026-02")).toHaveLength(28);
    expect(daysOf("2028-02")).toHaveLength(29);
    expect(daysOf("2026")).toHaveLength(365);
    expect(daysOf("2026-10-08")).toEqual(["2026-10-08"]);
  });
});

describe("closing", () => {
  it("closes a day at the next day's boundary", () => {
    expect(isClosed("2026-10-07", new Date("2026-10-08T03:59:00+02:00"), madrid)).toBe(false);
    expect(isClosed("2026-10-07", new Date("2026-10-08T04:00:00+02:00"), madrid)).toBe(true);
  });

  it("closes a week on Monday at 04:00", () => {
    expect(isClosed("2026-W41", new Date("2026-10-12T03:00:00+02:00"), madrid)).toBe(false);
    expect(isClosed("2026-W41", new Date("2026-10-12T04:00:00+02:00"), madrid)).toBe(true);
  });

  it("closes months and years at the boundary after their last day", () => {
    expect(isClosed("2026-10", new Date("2026-11-01T02:00:00+01:00"), madrid)).toBe(false);
    expect(isClosed("2026-10", new Date("2026-11-01T05:00:00+01:00"), madrid)).toBe(true);
    expect(isClosed("2026", new Date("2026-12-31T23:00:00+01:00"), madrid)).toBe(false);
    expect(isClosed("2026", new Date("2027-01-01T04:00:00+01:00"), madrid)).toBe(true);
  });
});
