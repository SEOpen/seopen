import { describe, expect, it } from "vitest";
import { jobTime, mondayJobTime, weeklyJobDays, zonedJobTime } from "./schedule";

// New York is on standard time (UTC-5) and London on GMT.
const WINTER = new Date("2026-11-03T15:00:00Z");
// New York is on daylight time (UTC-4) and London on BST (UTC+1).
const SUMMER = new Date("2026-07-15T15:00:00Z");
// New York has changed its clocks (Mar 8, 2026) and London hasn't yet (Mar 29), so they're 4 hours apart.
const BETWEEN_CHANGES = new Date("2026-03-16T15:00:00Z");

describe("jobTime", () => {
  it("reads the same in the schedule's own zone", () => {
    expect(jobTime("06:00", "America/New_York", WINTER)).toBe("06:00");
    expect(jobTime("06:00", "America/New_York", SUMMER)).toBe("06:00");
  });
  it("converts to the workspace's zone", () => {
    expect(jobTime("06:00", "Europe/London", WINTER)).toBe("11:00");
    expect(jobTime("06:00", "Asia/Tokyo", WINTER)).toBe("20:00");
    expect(jobTime("06:30", "America/Los_Angeles", WINTER)).toBe("03:30");
    expect(jobTime("06:00", "Asia/Calcutta", WINTER)).toBe("16:30");
    expect(jobTime("06:00", "UTC", WINTER)).toBe("11:00");
  });
  it("follows both zones' daylight saving", () => {
    expect(jobTime("06:00", "Asia/Tokyo", SUMMER)).toBe("19:00");
    expect(jobTime("06:00", "Europe/London", SUMMER)).toBe("11:00");
    expect(jobTime("06:00", "Europe/London", BETWEEN_CHANGES)).toBe("10:00");
  });
  it("uses the schedule's calendar day, whatever day it already is elsewhere", () => {
    // Nov 3 04:53 UTC is still Nov 2 in New York, a Monday; both dates are on standard time.
    expect(jobTime("06:00", "Asia/Tokyo", new Date("2026-11-03T04:53:00Z"))).toBe("20:00");
  });
  it("is right on the day New York changes its clocks", () => {
    // Mar 8, 2026: 02:00 EST becomes 03:00 EDT, so 06:00 that day is already daylight time, 10:00 UTC.
    expect(jobTime("06:00", "UTC", new Date("2026-03-08T15:00:00Z"))).toBe("10:00");
    // Nov 1, 2026: 02:00 EDT becomes 01:00 EST, so 05:30 and 06:00 that day are standard time.
    expect(jobTime("05:30", "UTC", new Date("2026-11-01T15:00:00Z"))).toBe("10:30");
    expect(jobTime("06:00", "UTC", new Date("2026-11-01T15:00:00Z"))).toBe("11:00");
  });
  it("shows midnight as 00:00", () => {
    expect(jobTime("05:00", "Pacific/Honolulu", WINTER)).toBe("00:00");
  });
});

describe("zonedJobTime", () => {
  it("names the zone after the time", () => {
    expect(zonedJobTime("06:00", "America/New_York", WINTER)).toBe("06:00 ET");
    expect(zonedJobTime("06:00", "America/Los_Angeles", SUMMER)).toBe("03:00 PT");
    expect(zonedJobTime("06:00", "Asia/Tokyo", WINTER)).toBe("20:00 GMT+9");
    expect(zonedJobTime("06:00", "UTC", WINTER)).toBe("11:00 UTC");
  });
  it("follows daylight saving in a zone that reads as its offset", () => {
    expect(zonedJobTime("06:00", "Europe/London", WINTER)).toBe("11:00 GMT");
    expect(zonedJobTime("06:00", "Europe/London", SUMMER)).toBe("11:00 GMT+1");
  });
});

describe("mondayJobTime", () => {
  it("stays Monday where it's still Monday", () => {
    expect(mondayJobTime("07:30", "America/New_York", WINTER)).toEqual({ day: "Mon", days: "Mondays", time: "07:30", zoned: "07:30 ET" });
    expect(mondayJobTime("07:00", "Europe/London", WINTER)).toEqual({ day: "Mon", days: "Mondays", time: "12:00", zoned: "12:00 GMT" });
    expect(mondayJobTime("07:00", "Asia/Tokyo", WINTER)).toEqual({ day: "Mon", days: "Mondays", time: "21:00", zoned: "21:00 GMT+9" });
  });
  it("moves the day where the time crosses midnight", () => {
    expect(mondayJobTime("07:00", "Pacific/Auckland", WINTER)).toEqual({ day: "Tue", days: "Tuesdays", time: "01:00", zoned: "01:00 GMT+13" });
    expect(mondayJobTime("00:30", "Pacific/Honolulu", WINTER)).toEqual({ day: "Sun", days: "Sundays", time: "19:30", zoned: "19:30 HST" });
  });
  it("converts for the coming Monday, not today", () => {
    // Saturday Mar 7, 2026: New York's clocks change the next morning, so Monday's run is at UTC-4.
    expect(mondayJobTime("07:00", "UTC", new Date("2026-03-07T15:00:00Z")).time).toBe("11:00");
    expect(jobTime("07:00", "UTC", new Date("2026-03-07T15:00:00Z"))).toBe("12:00");
  });
});

describe("weeklyJobDays", () => {
  const SUNDAY_FIRST = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const labels = (zone: string, now: Date) => weeklyJobDays("06:00", zone, now).map((d) => d.label);
  const labelOf = (value: number, zone: string, now: Date) => weeklyJobDays("06:00", zone, now).find((d) => d.value === value)?.label;

  it("reads as itself wherever the job's date is the local date", () => {
    for (const zone of ["America/New_York", "America/Los_Angeles", "Europe/London", "Asia/Tokyo", "Asia/Kolkata", "Pacific/Honolulu"]) {
      for (const now of [WINTER, SUMMER]) {
        expect(weeklyJobDays("06:00", zone, now)).toEqual(SUNDAY_FIRST.map((label, value) => ({ value, label })));
      }
    }
  });
  it("matches the UTC weekday the job picks its sweep by, on every day of the year", () => {
    // tracker.ts compares the UTC weekday at 06:00 on the schedule's clock; the two calendars agree then, also on clock-change days.
    for (let i = 0; i < 365; i++) {
      const now = new Date(Date.UTC(2026, 0, 1 + i, 15));
      expect(labels("UTC", now)).toEqual(SUNDAY_FIRST);
      expect(labelOf(3, "UTC", now)).toBe("Wednesday");
    }
  });
  it("moves the day where the check crosses midnight", () => {
    // 06:00 in New York is 11:00 UTC in winter: already 00:00 the next day in Auckland (UTC+13).
    expect(labelOf(0, "Pacific/Auckland", WINTER)).toBe("Monday");
    expect(labelOf(6, "Pacific/Auckland", WINTER)).toBe("Sunday");
    // In July it's 10:00 UTC and Auckland is UTC+12: 22:00 the same day.
    expect(labelOf(0, "Pacific/Auckland", SUMMER)).toBe("Sunday");
    // 10:00 UTC in Pago Pago (UTC-11) is 23:00 the day before.
    expect(labelOf(0, "Pacific/Pago_Pago", SUMMER)).toBe("Saturday");
  });
  it("keeps one label per value, in order, in the week the schedule's clock changes", () => {
    for (const now of [new Date("2026-10-30T15:00:00Z"), new Date("2027-03-12T15:00:00Z")]) {
      expect(labels("Pacific/Auckland", now)).toEqual(SUNDAY_FIRST);
      expect(new Set(weeklyJobDays("06:00", "Pacific/Auckland", now).map((d) => d.value)).size).toBe(7);
    }
  });
});
