import type { DashboardFixtures } from "@/components/ui/module-card";
import type { GoogleDashboardData } from "./dashboard";
import { addDays } from "./windowing";

const END = "2026-10-27";

/** 28 daily points ending at END, a weekday rhythm around `base` clicks; position drifts from `pos` by about 2 places. */
function days(base: number, n = 28, pos = 14): GoogleDashboardData["series"] {
  return Array.from({ length: n }, (_, i) => {
    const weekend = (i + 2) % 7 >= 5;
    const wobble = Math.round(Math.sin(i * 1.7) * base * 0.12);
    const position = Math.round((pos + 1 - (i / n) * 2 + Math.cos(i * 1.3) * 0.6) * 10) / 10;
    return { date: addDays(END, i - (n - 1)), clicks: Math.max(0, Math.round(base * (weekend ? 0.62 : 1) + wobble + i * base * 0.004)), position };
  });
}

export const fixtures: DashboardFixtures<GoogleDashboardData> = {
  full: {
    end: END,
    current: { clicks: 4318, impressions: 182_460, ctr: 4318 / 182_460, position: 14.2 },
    previous: { clicks: 3874, impressions: 190_112, ctr: 3874 / 190_112, position: 15.9 },
    series: days(154),
  },
  sparse: {
    end: END,
    current: { clicks: 37, impressions: 1_204, ctr: 37 / 1_204, position: 31.6 },
    previous: null,
    series: days(9, 4, 31.6),
  },
  long: {
    end: END,
    current: { clicks: 99_999, impressions: 48_213_977, ctr: 99_999 / 48_213_977, position: 102.4 },
    previous: { clicks: 7_481, impressions: 48_213_977, ctr: 7_481 / 48_213_977, position: 8.9 },
    series: days(3570, 28, 102.4),
  },
  more: {
    "no impressions": { end: END, current: { clicks: 0, impressions: 0, ctr: 0, position: 0 }, previous: { clicks: 0, impressions: 0, ctr: 0, position: 0 }, series: [] },
  },
};
