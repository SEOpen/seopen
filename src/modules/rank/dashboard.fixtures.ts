import type { DashboardFixtures } from "@/components/ui/module-card";
import type { RankDashboardData } from "./dashboard";

const END = "2026-10-27";

function day(offset: number): string {
  const d = new Date(`${END}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

/** `n` daily points ending at END: visibility drifts from `from` to `to`, and average position improves as it rises. */
function series(from: number, to: number, n = 30): RankDashboardData["series"] {
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 1 : i / (n - 1);
    const wobble = Math.sin(i * 1.3) * Math.abs(to - from) * 0.15;
    const visibility = Math.max(0, from + (to - from) * t + wobble);
    return { date: day(i - (n - 1)), visibility, avgPosition: Math.round((1 + (1 - visibility) * 20) * 10) / 10 };
  });
}

/** Nothing in this check rests on a position no look confirmed. */
const confirmed = { visibilityNotConfirmed: 0, top3NotConfirmed: 0, top10NotConfirmed: 0, rankingNotConfirmed: 0 };

export const fixtures: DashboardFixtures<RankDashboardData> = {
  full: {
    keywords: 48,
    ranking: 31,
    latest: { date: END, visibility: 0.1834, top3: 7, top10: 19, ...confirmed, avgPosition: 14.6, avgPositionConfirmed: 14.6 },
    previous: { date: day(-7), visibility: 0.1592, top3: 5, top10: 21, ...confirmed, avgPosition: 16.1, avgPositionConfirmed: 16.1 },
    series: series(0.142, 0.1834),
    enabled: true,
    pageOneGainsNotConfirmed: 0,
  },
  sparse: {
    keywords: 3,
    ranking: 1,
    latest: { date: END, visibility: 0.0021, top3: 0, top10: 0, ...confirmed, avgPosition: 47.3, avgPositionConfirmed: 47.3 },
    previous: null,
    series: series(0.0021, 0.0021, 1),
    enabled: false,
    pageOneGainsNotConfirmed: 0,
  },
  long: {
    keywords: 99_999,
    ranking: 99_999,
    latest: { date: END, visibility: 1, top3: 99_999, top10: 99_999, ...confirmed, avgPosition: 100, avgPositionConfirmed: 100 },
    previous: { date: day(-7), visibility: 0.0001, top3: 0, top10: 1, ...confirmed, avgPosition: 1.2, avgPositionConfirmed: 1.2 },
    series: series(0.0001, 1),
    enabled: true,
    pageOneGainsNotConfirmed: 0,
  },
  more: {
    "nothing ranks": {
      keywords: 12,
      ranking: 0,
      latest: { date: END, visibility: 0, top3: 0, top10: 0, ...confirmed, avgPosition: null, avgPositionConfirmed: null },
      previous: { date: day(-7), visibility: 0.012, top3: 0, top10: 1, ...confirmed, avgPosition: 62.5, avgPositionConfirmed: 62.5 },
      series: [
        { date: day(-7), visibility: 0.012, avgPosition: 62.5 },
        { date: END, visibility: 0, avgPosition: null },
      ],
      enabled: true,
      pageOneGainsNotConfirmed: 0,
    },
    // Four keywords no look could find kept their positions, two of them in the top 3, and they're the whole page one gain.
    "positions not confirmed": {
      keywords: 48,
      ranking: 31,
      latest: { date: END, visibility: 0.1834, visibilityNotConfirmed: 0.0381, top3: 7, top3NotConfirmed: 2, top10: 23, top10NotConfirmed: 4, avgPosition: 14.6, rankingNotConfirmed: 4, avgPositionConfirmed: 16.0 },
      previous: { date: day(-7), visibility: 0.1592, top3: 5, top10: 19, ...confirmed, avgPosition: 16.1, avgPositionConfirmed: 16.1 },
      series: series(0.142, 0.1834),
      enabled: true,
      pageOneGainsNotConfirmed: 4,
    },
  },
};
