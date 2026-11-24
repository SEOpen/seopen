import { and, count, eq } from "drizzle-orm";
import { compare, Kpi, KpiRow, ModuleSection, type DashboardModule } from "@/components/ui/module-card";
import { deltaBetween } from "@/components/ui/what-changed";
import { db } from "@/db";
import { rankKeywords } from "@/db/schema";
import { isFree } from "@/lib/billing/gates";
import { loadBillingWorkspace } from "@/lib/billing/workspace";
import { countDeltaFromZero } from "@/lib/brief";
import { formatDay, formatNumber, formatPct } from "@/lib/format";
import type { Project } from "@/lib/projects";
import { inScope, projectScope } from "@/lib/workspace";
import { pointsNotConfirmed, waitingOnFirstCheck } from "./brief";
import { MetricChart } from "./components/metric-chart";
import { rankFailure } from "./failure";
import { pageOneGainsNotConfirmed, pageOneGainUnconfirmed, summarizeByDate } from "./metrics";
import { currentPlaceFilter, hasActiveRun, newestRuns, recentDailyPositions } from "./queries";
import { carryDeepPositions } from "./recheck";
import { getSettings } from "./tracker";

const DAYS = 30;

interface CheckSummary {
  /** Check day, "YYYY-MM-DD". */
  date: string;
  /** Share of possible CTR-weighted clicks, 0–1. */
  visibility: number | null;
  /** How much of `visibility` no look could confirm in this check, on the same scale. */
  visibilityNotConfirmed: number;
  top3: number;
  /** How many of `top3` no look could confirm in this check. */
  top3NotConfirmed: number;
  top10: number;
  /** How many of `top10` no look could confirm in this check. */
  top10NotConfirmed: number;
  avgPosition: number | null;
  /** How many ranking positions in this check no look could confirm. */
  rankingNotConfirmed: number;
  /** `avgPosition` without them; null when they're all that rank. */
  avgPositionConfirmed: number | null;
}

export interface RankDashboardData {
  /** Active keywords in the latest check. */
  keywords: number;
  /** Those that rank at all, the ones the average position is taken over. */
  ranking: number;
  latest: CheckSummary;
  /** The check nearest 7 days earlier, else the oldest in range; null when there is only one check. */
  previous: CheckSummary | null;
  /** Daily visibility and average position over the last 30 days, oldest first. */
  series: { date: string; visibility: number | null; avgPosition: number | null }[];
  /** Whether the daily check is turned on. With it off, no more checks are coming. */
  enabled: boolean;
  /** Keywords on page one in `latest`, and not in `previous`, on a position no look could confirm. */
  pageOneGainsNotConfirmed: number;
}

/** Visibility and its 30-day trend from stored checks. Database reads only. */
async function load(project: Project): Promise<RankDashboardData | null> {
  const scope = projectScope(project);
  const [rows, settings] = await Promise.all([recentDailyPositions(scope, DAYS, currentPlaceFilter(project)), getSettings(scope)]);
  if (!rows.length) return null;
  const carried = carryDeepPositions(rows);
  const series = summarizeByDate(carried);
  const end = series[series.length - 1];
  // Compare with the check closest to 7 days earlier, else the first one available.
  const weekAgo = [...series].reverse().find((s) => s.date <= shiftBack(end.date, 7)) ?? series[0];
  const pick = (s: (typeof series)[number]): CheckSummary => ({
    date: s.date,
    visibility: s.visibility,
    visibilityNotConfirmed: s.visibilityNotConfirmed,
    top3: s.top3,
    top3NotConfirmed: s.top3NotConfirmed,
    top10: s.top10,
    top10NotConfirmed: s.top10NotConfirmed,
    avgPosition: s.avgPosition,
    rankingNotConfirmed: s.rankingNotConfirmed,
    avgPositionConfirmed: s.avgPositionConfirmed,
  });
  return {
    keywords: end.keywords,
    ranking: end.top100,
    latest: pick(end),
    previous: weekAgo === end ? null : pick(weekAgo),
    series: series.map((s) => ({ date: s.date, visibility: s.visibility, avgPosition: s.avgPosition })),
    enabled: settings.enabled,
    pageOneGainsNotConfirmed: weekAgo === end ? 0 : pageOneGainsNotConfirmed(carried, weekAgo.date, end.date),
  };
}

/** Keywords added but not checked yet, and whether their first check is under way. Free runs none. */
async function waiting(project: Project): Promise<string | null> {
  const scope = projectScope(project);
  const [[{ n }], running, ws] = await Promise.all([
    db
      .select({ n: count() })
      .from(rankKeywords)
      .where(and(inScope(rankKeywords, scope), eq(rankKeywords.active, true))),
    hasActiveRun(scope),
    loadBillingWorkspace(project.workspaceId),
  ]);
  return n ? waitingOnFirstCheck(n, running, isFree(ws)) : null;
}

/** Projects whose newest check failed, read together. Database reads only. */
async function failures(projects: Project[], timeZone: string) {
  const runs = await newestRuns(projects[0].workspaceId, projects.map((p) => p.id));
  return new Map(runs.flatMap((run) => {
    const failure = rankFailure(run, timeZone);
    return failure ? [[run.projectId, failure] as const] : [];
  }));
}

function shiftBack(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function describe(d: RankDashboardData) {
  return `${formatNumber(d.keywords)} keywords · last check ${formatDay(d.latest.date)}`;
}

function changes(d: RankDashboardData) {
  const { latest: cur, previous: prev } = d;
  return [
    compare("Visibility", cur.visibility, prev?.visibility, { unit: "points", format: (n) => formatPct(n) }),
    compare("Top 3", cur.top3, prev?.top3, { count: true }),
    // The plain difference, as the strip beside it shows this one: "6 of 48" reads in keywords, not a percentage.
    // A gain no look confirmed is neither better nor worse, as the strip shows it, so What changed leaves it out.
    compare("On page one", cur.top10, prev?.top10, { goodWhen: pageOneGainUnconfirmed(d) ? "neither" : "up" }),
    compare("Tracked position", cur.avgPosition, prev?.avgPosition, { unit: "decimal", goodWhen: "down", format: (n) => n.toFixed(1), rank: true }),
  ];
}

function View({ data: d }: { data: RankDashboardData }) {
  const { latest: cur, previous: prev } = d;
  return (
    <>
      <ModuleSection>
        <KpiRow>
          {/* Each counts positions no look confirmed, so each says how much, as Rankings does. */}
          <Kpi label="Visibility" value={formatPct(cur.visibility)} delta={deltaBetween(cur.visibility, prev?.visibility, "points")} hint={pointsNotConfirmed(cur.visibilityNotConfirmed) || undefined} />
          <Kpi label="Top 3" value={formatNumber(cur.top3)} delta={countDeltaFromZero(cur.top3, prev?.top3)} hint={cur.top3NotConfirmed ? `${formatNumber(cur.top3NotConfirmed)} not confirmed` : undefined} />
        </KpiRow>
      </ModuleSection>
      {d.series.length > 1 && (
        <ModuleSection>
          <MetricChart
            height={120}
            metrics={[{ key: "visibility", label: "Visibility", format: "pct", series: [{ key: "visibility", label: "Visibility" }], data: d.series }]}
          />
        </ModuleSection>
      )}
    </>
  );
}

export const dashboard: DashboardModule<RankDashboardData> = {
  id: "rank",
  label: "Rankings",
  href: "/rank",
  setup: { text: "no tracked keywords yet", href: "/rank" },
  load,
  waiting,
  failures,
  describe,
  baseline: (d) => (d.previous ? formatDay(d.previous.date) : null),
  changes,
  View,
};
