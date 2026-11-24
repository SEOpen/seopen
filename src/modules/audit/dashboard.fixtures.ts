import type { DashboardFixtures } from "@/components/ui/module-card";
import type { AuditDashboardData } from "./dashboard";

const FINISHED = "2026-10-27T14:32:00.000Z";

const full: AuditDashboardData = {
  timeZone: "America/New_York",
  latest: { finishedAt: FINISHED, pages: 1_204, score: 82.4, errors: 37, warnings: 412, notices: 1_890, pagesWithErrors: 21 },
  changes: { score: 3.1, errors: -12, warnings: 28, notices: -140, pagesWithErrors: -4 },
  running: null,
  weekly: true,
};

export const fixtures: DashboardFixtures<AuditDashboardData> = {
  full,
  sparse: {
    timeZone: "America/New_York",
    latest: { finishedAt: FINISHED, pages: 48, score: 64, errors: 9, warnings: 61, notices: 120, pagesWithErrors: 5 },
    changes: null,
    running: null,
    weekly: false,
  },
  long: {
    timeZone: "America/New_York",
    latest: { finishedAt: FINISHED, pages: 99_999, score: 12.6, errors: 99_999, warnings: 4_821_377, notices: 48_213_977, pagesWithErrors: 99_999 },
    changes: { score: -71.4, errors: 99_999, warnings: -1_234_567, notices: 48_213_977, pagesWithErrors: 99_999 },
    running: { pagesCrawled: 99_999, maxPages: 4_821_377 },
    weekly: true,
  },
  more: {
    "first crawl running": {
      timeZone: "America/New_York",
      latest: null,
      changes: null,
      running: { pagesCrawled: 120, maxPages: 500 },
      weekly: false,
    },
    "crawl running": { ...full, running: { pagesCrawled: 640, maxPages: 1_500 } },
    "no change": {
      timeZone: "America/New_York",
      latest: { finishedAt: FINISHED, pages: 312, score: 97, errors: 0, warnings: 4, notices: 22, pagesWithErrors: 0 },
      changes: { score: 0, errors: 0, warnings: 0, notices: 0, pagesWithErrors: 0 },
      running: null,
      weekly: true,
    },
  },
};
