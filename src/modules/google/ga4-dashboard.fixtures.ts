import type { DashboardFixtures } from "@/components/ui/module-card";
import type { Ga4DashboardData } from "./ga4-dashboard";
import { addDays } from "./windowing";

const END = "2026-10-27";

/** Daily points ending at END, a weekday rhythm around `base`. */
function days(base: number, n = 28): Ga4DashboardData["series"] {
  return Array.from({ length: n }, (_, i) => {
    const weekend = (i + 2) % 7 >= 5;
    const wobble = Math.round(Math.sin(i * 1.3) * base * 0.1);
    return { date: addDays(END, i - (n - 1)), sessions: Math.max(0, Math.round(base * (weekend ? 0.7 : 1) + wobble + i * base * 0.003)) };
  });
}

export const fixtures: DashboardFixtures<Ga4DashboardData> = {
  full: {
    end: END,
    current: { sessions: 5_206, engagedSessions: 3_384, keyEvents: 142, totalRevenue: 0 },
    previous: { sessions: 4_871, engagedSessions: 3_264, keyEvents: 151, totalRevenue: 0 },
    series: days(186),
  },
  sparse: {
    end: END,
    current: { sessions: 48, engagedSessions: 27, keyEvents: 1, totalRevenue: 0 },
    previous: null,
    series: days(12, 4),
  },
  long: {
    end: END,
    current: { sessions: 99_999, engagedSessions: 61_204, keyEvents: 48_213_977, totalRevenue: 1_234_567 },
    previous: { sessions: 7_481, engagedSessions: 2_090, keyEvents: 3_612_000, totalRevenue: 98_765 },
    series: days(3570),
  },
  more: {
    "with revenue": {
      end: END,
      current: { sessions: 12_480, engagedSessions: 8_112, keyEvents: 384, totalRevenue: 18_420 },
      previous: { sessions: 13_102, engagedSessions: 8_360, keyEvents: 402, totalRevenue: 21_075 },
      series: days(446),
    },
    "no sessions": { end: END, current: { sessions: 0, engagedSessions: 0, keyEvents: 0, totalRevenue: 0 }, previous: { sessions: 0, engagedSessions: 0, keyEvents: 0, totalRevenue: 0 }, series: [] },
  },
};
