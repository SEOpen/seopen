import { describe, expect, it } from "vitest";
import { timeZoneName, timeZoneOptions, zoneLabel } from "./time-zones";

const WINTER = new Date("2026-11-03T15:00:00Z");

describe("timeZoneName", () => {
  it("reads as a place", () => {
    expect(timeZoneName("America/New_York")).toBe("America/New York");
    expect(timeZoneName("UTC")).toBe("UTC");
  });
  it("uses a city's current name", () => {
    expect(timeZoneName("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(timeZoneName("Europe/Kiev")).toBe("Europe/Kyiv");
  });
});

describe("zoneLabel", () => {
  it("reads the same as the picker", () => {
    expect(zoneLabel("America/New_York", WINTER)).toBe("New York (GMT-5)");
    expect(zoneLabel("UTC", WINTER)).toBe("UTC");
    const labels = timeZoneOptions("America/New_York", WINTER).flatMap((g) => g.zones);
    expect(labels.find((z) => z.value === "America/Indiana/Knox")?.label).toBe(zoneLabel("America/Indiana/Knox", WINTER));
  });
});

describe("timeZoneOptions", () => {
  const groups = timeZoneOptions("America/New_York", WINTER);
  const all = groups.flatMap((g) => g.zones);
  const labelOf = (value: string) => all.find((z) => z.value === value)?.label;

  it("starts with UTC, once", () => {
    expect(groups[0]).toEqual({ region: "UTC", zones: [{ value: "UTC", label: "UTC" }] });
    expect(all.filter((z) => z.value === "UTC")).toHaveLength(1);
  });
  it("labels each zone by city with its offset at that moment", () => {
    expect(labelOf("Asia/Tokyo")).toBe("Tokyo (GMT+9)");
    expect(labelOf("America/New_York")).toBe("New York (GMT-5)");
    expect(labelOf("Europe/London")).toMatch(/^London \(GMT(\+0)?\)$/);
    expect(labelOf("America/Indiana/Knox")).toBe("Knox, Indiana (GMT-6)");
  });
  it("only offers zones Intl can use, with no duplicates", () => {
    expect(new Set(all.map((z) => z.value)).size).toBe(all.length);
    for (const { value } of all) expect(() => new Intl.DateTimeFormat("en-US", { timeZone: value })).not.toThrow();
  });
  it("keeps a stored zone that isn't in the runtime's list", () => {
    const stored = timeZoneOptions("US/Eastern", WINTER).flatMap((g) => g.zones);
    expect(stored.find((z) => z.value === "US/Eastern")?.label).toBe("Eastern (GMT-5)");
  });
});
