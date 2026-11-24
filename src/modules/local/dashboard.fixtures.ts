import type { DashboardFixtures } from "@/components/ui/module-card";
import type { LocalDashboardData } from "./dashboard";

const AT = "2026-11-02T06:42:00.000Z";
const WEEK_AGO = "2026-10-26T06:40:00.000Z";

export const fixtures: DashboardFixtures<LocalDashboardData> = {
  full: {
    businesses: 2,
    keywords: 5,
    weekly: true,
    timeZone: "America/New_York",
    latest: { at: AT, avgRank: 4.2, top3: 0.36, found: 0.82, answered: 125 },
    previous: { at: WEEK_AGO, avgRank: 5.1, top3: 0.28, found: 0.78, answered: 125 },
    rows: [
      { id: 1, title: "Fernhill Coffee", avgRank: 3.4, found: "68/75" },
      { id: 2, title: "Fernhill Coffee – Eastside", avgRank: 5.6, found: "35/50" },
    ],
  },
  sparse: {
    businesses: 1,
    keywords: 1,
    weekly: false,
    timeZone: "America/New_York",
    latest: { at: AT, avgRank: null, top3: 0, found: 0, answered: 8 },
    previous: null,
    rows: [{ id: 1, title: "Fernhill Coffee", avgRank: null, found: "0/8" }],
  },
  long: {
    businesses: 999,
    keywords: 19_980,
    weekly: true,
    timeZone: "America/New_York",
    latest: { at: AT, avgRank: 19.9, top3: 1, found: 1, answered: 979_020 },
    previous: { at: WEEK_AGO, avgRank: 1, top3: 0, found: 0.0001, answered: 979_020 },
    rows: Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      title: `Fernhill Coffee and Bakery Company, Northwest Industrial District Location ${i + 1}`,
      avgRank: 19.9,
      found: "49/49",
    })),
  },
};
