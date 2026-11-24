import type { DashboardFixtures } from "@/components/ui/module-card";
import type { BacklinksDashboardData } from "./dashboard";

const END = "2026-10-27";

/** `n` weekly snapshots ending at END, drifting from `start` by `step` per week with some noise. */
function weekly(start: number, step: number, n = 26): BacklinksDashboardData["series"] {
  const end = new Date(2026, 9, 27);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(end);
    d.setDate(end.getDate() - (n - 1 - i) * 7);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { date, referringDomains: Math.max(0, Math.round(start + i * step + Math.sin(i * 1.3) * step * 1.5)) };
  });
}

const fullSeries = weekly(1_180, 9);
const longSeries = weekly(80_000, 780);

export const fixtures: DashboardFixtures<BacklinksDashboardData> = {
  full: {
    date: END,
    previousDate: "2026-10-20",
    referringDomains: fullSeries.at(-1)!.referringDomains,
    referringDomainsChange: fullSeries.at(-1)!.referringDomains - fullSeries.at(-2)!.referringDomains,
    backlinks: 18_942,
    backlinksChange: -311,
    dofollowShare: 0.734,
    spamScore: 4,
    series: fullSeries,
  },
  sparse: {
    date: END,
    previousDate: null,
    referringDomains: 37,
    referringDomainsChange: null,
    backlinks: 212,
    backlinksChange: null,
    dofollowShare: 0.61,
    spamScore: null,
    series: [{ date: END, referringDomains: 37 }],
  },
  long: {
    date: END,
    previousDate: "2026-10-20",
    referringDomains: 99_999,
    referringDomainsChange: -99_999,
    backlinks: 48_213_977,
    backlinksChange: 1_234_567,
    dofollowShare: 1,
    spamScore: 100,
    series: longSeries,
  },
  more: {
    "two snapshots, no change": {
      date: END,
      previousDate: "2026-10-20",
      referringDomains: 412,
      referringDomainsChange: 0,
      backlinks: 2_960,
      backlinksChange: 0,
      dofollowShare: null,
      spamScore: 12,
      series: [
        { date: "2026-10-20", referringDomains: 412 },
        { date: END, referringDomains: 412 },
      ],
    },
  },
};
