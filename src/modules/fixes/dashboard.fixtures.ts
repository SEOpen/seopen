import type { DashboardFixtures } from "@/components/ui/module-card";
import type { FixesDashboardData } from "./dashboard";

export const fixtures: DashboardFixtures<FixesDashboardData> = {
  full: {
    open: 23,
    inProgress: 4,
    measured: 12,
    lines: ["Fixed 12 titles on Oct 14. Clicks up 18% in 14 days, from 410 to 484, while the whole site rose 3%.", "Fixed 1 sitemap on Oct 2. Clicks held about level in 28 days, at 2,180. No clear change yet."],
    fixedPages: { clicks: 484, previousClicks: 410 },
  },
  sparse: { open: 3, inProgress: 0, measured: 0, lines: [], fixedPages: null },
  long: {
    open: 99_999,
    inProgress: 12_345,
    measured: 48_210,
    lines: ["Fixed 12,345 canonical tags on Oct 14. Impressions down 41% in 28 days, from 1,234,567 to 728,394, while the whole site fell 38%."],
    fixedPages: { clicks: 1_234_567, previousClicks: 728_394 },
  },
  more: { "all clear": { open: 0, inProgress: 0, measured: 8, lines: ["Fixed 8 descriptions on Sep 30. Too little traffic in 28 days to tell."], fixedPages: { clicks: 9, previousClicks: 7 } } },
};
