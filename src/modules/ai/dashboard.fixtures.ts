import type { DashboardFixtures } from "@/components/ui/module-card";
import type { AiDashboardData } from "./dashboard";

const AT = "2026-10-27T14:32:00.000Z";

/** Cited answers after each weekly run, ending on the day of AT. */
function trend(...cited: number[]): AiDashboardData["trend"] {
  return cited.map((n, i) => {
    const d = new Date("2026-10-27T12:00:00Z");
    d.setUTCDate(d.getUTCDate() - 7 * (cited.length - 1 - i));
    return { date: d.toISOString().slice(0, 10), cited: n };
  });
}

export const fixtures: DashboardFixtures<AiDashboardData> = {
  full: {
    lastRunAt: AT,
    timeZone: "America/New_York",
    current: { total: 40, mentioned: 12, cited: 7, score: 12 / 40, citedRate: 7 / 40 },
    previous: { total: 40, mentioned: 9, cited: 6, score: 9 / 40, citedRate: 6 / 40 },
    failed: 0,
    engines: 5,
    trend: trend(3, 4, 4, 5, 6, 7),
    branded: "left out",
  },
  sparse: {
    lastRunAt: AT,
    timeZone: "America/New_York",
    current: { total: 4, mentioned: 1, cited: 0, score: 1 / 4, citedRate: 0 },
    previous: null,
    failed: 0,
    engines: 2,
    trend: trend(0),
    branded: null,
  },
  long: {
    lastRunAt: AT,
    timeZone: "America/New_York",
    current: { total: 99_999, mentioned: 99_998, cited: 99_999, score: 99_998 / 99_999, citedRate: 1 },
    previous: { total: 99_999, mentioned: 12, cited: 0, score: 12 / 99_999, citedRate: 0 },
    failed: 0,
    engines: 5,
    trend: trend(0, 99_999),
    branded: "counted",
  },
  more: {
    "visibility dropped": {
      lastRunAt: AT,
      timeZone: "America/New_York",
      current: { total: 40, mentioned: 6, cited: 2, score: 6 / 40, citedRate: 2 / 40 },
      previous: { total: 40, mentioned: 12, cited: 7, score: 12 / 40, citedRate: 7 / 40 },
      failed: 0,
      engines: 5,
      trend: trend(5, 7, 7, 2),
      branded: null,
    },
    "no change": {
      lastRunAt: AT,
      timeZone: "America/New_York",
      current: { total: 40, mentioned: 12, cited: 7, score: 12 / 40, citedRate: 7 / 40 },
      previous: { total: 40, mentioned: 12, cited: 7, score: 12 / 40, citedRate: 7 / 40 },
      failed: 0,
      engines: 5,
      trend: trend(7, 7, 7),
      branded: null,
    },
  },
};
