import { describe, expect, it } from "vitest";
import { canonicalTimeZone, DEFAULT_TIME_ZONE, formatDate, formatDateTime, formatDateTimeZoned, formatDay, formatPct, formatRate, formatShortDate, formatTimestamp, resolveTimeZone, timeZoneLabel } from "./format";

const NY = "America/New_York";
// Tuesday 04:53 UTC: still Monday evening in New York, already midday in Tokyo.
const NEAR_MIDNIGHT = new Date("2026-11-03T04:53:00Z");

describe("dates near midnight", () => {
  it("files an instant under its day in the workspace's zone", () => {
    expect(formatDate(NEAR_MIDNIGHT, NY)).toBe("Nov 2, 2026");
    expect(formatDate(NEAR_MIDNIGHT, "UTC")).toBe("Nov 3, 2026");
    expect(formatShortDate(NEAR_MIDNIGHT, NY)).toBe("Nov 2");
    expect(formatShortDate(NEAR_MIDNIGHT, "UTC")).toBe("Nov 3");
  });
  it("shows an instant's time in the workspace's zone", () => {
    expect(formatDateTime(NEAR_MIDNIGHT, NY)).toBe("Nov 2, 11:53 PM");
    expect(formatDateTime(NEAR_MIDNIGHT, "UTC")).toBe("Nov 3, 4:53 AM");
    expect(formatDateTime(NEAR_MIDNIGHT, "Asia/Tokyo")).toBe("Nov 3, 1:53 PM");
  });
  it("reads a Date and its ISO string the same, as server and client each receive it", () => {
    expect(formatDateTime(NEAR_MIDNIGHT.toISOString(), NY)).toBe(formatDateTime(NEAR_MIDNIGHT, NY));
  });
  it("gives a sortable timestamp that keeps same-day runs apart", () => {
    expect(formatTimestamp(NEAR_MIDNIGHT, NY)).toBe("2026-11-02 23:53");
    expect(formatTimestamp(NEAR_MIDNIGHT, "UTC")).toBe("2026-11-03 04:53");
    expect(formatTimestamp(new Date("2026-11-03T05:00:00Z"), NY)).toBe("2026-11-03 00:00");
  });
  it("follows the zone's clock across a daylight saving change", () => {
    // New York left daylight time at 06:00 UTC on Nov 1, 2026.
    expect(formatDateTime(new Date("2026-11-01T05:30:00Z"), NY)).toBe("Nov 1, 1:30 AM");
    expect(formatDateTime(new Date("2026-11-01T06:30:00Z"), NY)).toBe("Nov 1, 1:30 AM");
    expect(formatDateTime(new Date("2026-11-01T07:30:00Z"), NY)).toBe("Nov 1, 2:30 AM");
  });
});

describe("calendar dates", () => {
  it("keeps a bare date on its day in any zone", () => {
    expect(formatDay("2026-10-29")).toBe("Oct 29, 2026");
    for (const zone of [NY, "UTC", "Asia/Tokyo", "Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
      expect(formatDate("2026-10-29", zone)).toBe("Oct 29, 2026");
      expect(formatDateTime("2026-10-29", zone)).toBe("Oct 29, 2026");
      expect(formatShortDate("2026-10-29", zone)).toBe("Oct 29");
    }
  });
});

describe("empty values", () => {
  it("renders a dash", () => {
    expect(formatDay(null)).toBe("–");
    expect(formatDate(null, NY)).toBe("–");
    expect(formatShortDate(undefined, NY)).toBe("–");
    expect(formatDateTime(undefined, NY)).toBe("–");
  });
});

describe("canonicalTimeZone", () => {
  it("accepts real zones under their canonical name", () => {
    expect(canonicalTimeZone("Europe/London")).toBe("Europe/London");
    expect(canonicalTimeZone("america/new_york")).toBe("America/New_York");
    expect(canonicalTimeZone("UTC")).toBe("UTC");
  });
  it("refuses anything else", () => {
    for (const bad of ["Mars/Olympus_Mons", "", " ", "+05:00", "-08:00", "New York"]) expect(canonicalTimeZone(bad)).toBeNull();
  });
});

describe("resolveTimeZone", () => {
  it("keeps a real zone and falls back on a missing or bad one", () => {
    expect(resolveTimeZone("Europe/London")).toBe("Europe/London");
    expect(resolveTimeZone(null)).toBe(DEFAULT_TIME_ZONE);
    expect(resolveTimeZone("Mars/Olympus_Mons")).toBe(DEFAULT_TIME_ZONE);
  });
});

describe("formatPct", () => {
  it("renders a 0–1 ratio as a percentage", () => {
    expect(formatPct(0.39)).toBe("39.0%");
  });
});

describe("formatRate", () => {
  it("keeps two decimals under 1%, so small rates stay apart", () => {
    expect(formatRate(0.0007)).toBe("0.07%");
    expect(formatRate(0.0012)).toBe("0.12%");
  });
  it("uses one decimal from 1% up", () => {
    expect(formatRate(0.034)).toBe("3.4%");
  });
  it("shows a dash with no rate", () => {
    expect(formatRate(null)).toBe("–");
  });
});

describe("timeZoneLabel", () => {
  const WINTER = new Date("2026-11-03T04:53:00Z");
  const SUMMER = new Date("2026-07-15T15:00:00Z");
  it("uses a short everyday name where there is one, in any season", () => {
    expect(timeZoneLabel(NY, WINTER)).toBe("ET");
    expect(timeZoneLabel(NY, SUMMER)).toBe("ET");
    expect(timeZoneLabel("America/Los_Angeles", WINTER)).toBe("PT");
    expect(timeZoneLabel("America/Chicago", WINTER)).toBe("CT");
    expect(timeZoneLabel("America/Denver", WINTER)).toBe("MT");
  });
  it("reads as the offset elsewhere, following daylight saving", () => {
    expect(timeZoneLabel("Europe/London", WINTER)).toBe("GMT");
    expect(timeZoneLabel("Europe/London", SUMMER)).toBe("GMT+1");
    expect(timeZoneLabel("Asia/Tokyo", WINTER)).toBe("GMT+9");
    expect(timeZoneLabel("Asia/Kolkata", WINTER)).toBe("GMT+5:30");
    expect(timeZoneLabel("Asia/Calcutta", WINTER)).toBe("GMT+5:30");
  });
  it("says UTC for UTC and its aliases, whatever the runtime's ICU calls it", () => {
    for (const zone of ["UTC", "utc", "Etc/UTC", "Etc/UCT", "Etc/Universal", "Etc/Zulu", "UCT", "Universal", "Zulu"]) {
      expect(timeZoneLabel(zone, WINTER), zone).toBe("UTC");
      expect(timeZoneLabel(zone, SUMMER), zone).toBe("UTC");
    }
  });
  it("is short and present for every zone the runtime knows", () => {
    for (const zone of Intl.supportedValuesOf("timeZone")) {
      for (const at of [WINTER, SUMMER]) {
        expect(timeZoneLabel(zone, at), zone).toMatch(/^[A-Z][A-Za-z0-9+:-]{0,8}$/);
      }
    }
  });
});

describe("formatDateTimeZoned", () => {
  it("adds the zone to the time", () => {
    expect(formatDateTimeZoned(NEAR_MIDNIGHT, NY)).toBe("Nov 2, 11:53 PM ET");
    expect(formatDateTimeZoned(NEAR_MIDNIGHT, "Asia/Tokyo")).toBe("Nov 3, 1:53 PM GMT+9");
    expect(formatDateTimeZoned(NEAR_MIDNIGHT.toISOString(), "UTC")).toBe("Nov 3, 4:53 AM UTC");
  });
  it("leaves a calendar date and a missing value alone", () => {
    expect(formatDateTimeZoned("2026-10-29", NY)).toBe("Oct 29, 2026");
    expect(formatDateTimeZoned(null, NY)).toBe("–");
  });
});
