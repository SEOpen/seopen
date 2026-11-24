import { compare, Kpi, KpiRow, ModuleSection, type DashboardModule } from "@/components/ui/module-card";
import { Trend } from "@/components/ui/trend";
import { deltaBetween, type ChangeDelta } from "@/components/ui/what-changed";
import { changeDelta, countDelta } from "@/lib/brief";
import { dataStopped } from "@/lib/check-failure";
import { fillDays } from "@/lib/chart-rule";
import { formatDay, formatNumber, formatPct, formatUsd } from "@/lib/format";
import type { Project } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { analyticsCheckedThrough, ga4DataRange, ga4Series, ga4Totals } from "./data";
import { analyticsFailures } from "./failure";
import { comparesFairly } from "./ga4-brief";
import { pctChange, resolvePeriods, storedDays } from "./windowing";

const DAYS = 28;

/** GA4 Organic Search totals for one window. */
export interface Ga4Totals {
  sessions: number;
  engagedSessions: number;
  keyEvents: number;
  totalRevenue: number;
}

export interface Ga4DashboardData {
  /** Last day of the 28-day window, "YYYY-MM-DD" (property time zone). */
  end: string;
  current: Ga4Totals;
  /** The 28 days before, or null unless stored history covers all of them. */
  previous: Ga4Totals | null;
  /** Daily organic sessions across the window, oldest first. */
  series: { date: string; sessions: number }[];
  /**
   * The sync keeps asking, but no data has arrived for weeks (DATA_STOPPED_DAYS), so this window ended long ago
   * and its changes are no news, good or bad. Analytics' failure says why, wherever the card shows.
   */
  stopped?: boolean;
  /** Where the rows came from. PostHog, Plausible and Umami record no key events, so the card leaves that figure out for them. */
  source?: "ga4" | "posthog" | "plausible" | "umami";
}

/** Last 28 days of stored organic landing-page data (GA4, PostHog, Plausible or Umami) against the 28 before. Database reads only. */
async function load(project: Project): Promise<Ga4DashboardData | null> {
  // Any Analytics source fills the same table.
  if (!project.ga4Property && !project.posthogProject && !project.plausibleSite && !project.umamiSite) return null;
  const source = project.umamiSite ? "umami" : project.plausibleSite ? "plausible" : project.posthogProject ? "posthog" : "ga4";
  const [range, checkedThrough] = await Promise.all([ga4DataRange(projectScope(project)), analyticsCheckedThrough(projectScope(project), source)]);
  if (!range) return null;
  const periods = resolvePeriods(range.last, DAYS, "prev");
  const { current } = periods;
  // A part-stored earlier period would sum a few days against 28 and read as a huge rise.
  const previous = comparesFairly(periods, range.first) ? periods.previous : null;
  const [cur, prev, series] = await Promise.all([
    ga4Totals(projectScope(project), current),
    previous ? ga4Totals(projectScope(project), previous) : null,
    ga4Series(projectScope(project), current),
  ]);
  // A day inside stored history with no row had no organic sessions, so it's a zero, not a gap.
  const first = range.first > current.start ? range.first : current.start;
  return {
    end: range.last,
    source,
    current: cur,
    previous: prev,
    series: fillDays(series, first, range.last, (r) => r.sessions).map((p) => ({ date: p.date, sessions: p.value ?? 0 })),
    ...(dataStopped(checkedThrough, range.last) ? { stopped: true } : {}),
  };
}

function describe(d: Ga4DashboardData) {
  const days = storedDays(d, DAYS);
  return `${days} day${days === 1 ? "" : "s"} to ${formatDay(d.end)}`;
}

// Engagement rate means nothing without sessions.
const engagement = (t: Ga4Totals | null) => (t && t.sessions > 0 ? t.engagedSessions / t.sessions : null);
// Most content sites record no revenue; show the KPI only when either window has some.
const hasRevenue = (d: Ga4DashboardData) => d.current.totalRevenue > 0 || (d.previous?.totalRevenue ?? 0) > 0;
const usd = (n: number) => formatUsd(n, 0);
// Only GA4 has key events; the other sources store a zero that would read as "none happened".
const hasKeyEvents = (d: Ga4DashboardData) => (d.source ?? "ga4") === "ga4";

/** A change over a window that ended weeks ago, without its good or bad colour. */
const quiet = (d: Ga4DashboardData, delta: ChangeDelta | null): ChangeDelta | null => (delta && d.stopped ? { ...delta, tone: "muted" } : delta);

function changes(d: Ga4DashboardData) {
  const { current: cur, previous: prev } = d;
  // Old changes aren't news for "What changed".
  if (d.stopped) return [];
  return [
    compare("Organic sessions", cur.sessions, prev?.sessions, { unit: "percent" }),
    compare("Engagement rate", engagement(cur), engagement(prev), { unit: "points", format: (n) => formatPct(n), volume: prev ? Math.min(cur.sessions, prev.sessions) : null }),
    hasKeyEvents(d) ? compare("Key events", cur.keyEvents, prev?.keyEvents, { unit: "percent" }) : null,
    hasRevenue(d) ? compare("Revenue", cur.totalRevenue, prev?.totalRevenue, { unit: "percent", format: usd, money: true }) : null,
  ];
}

function View({ data: d }: { data: Ga4DashboardData }) {
  const { current: cur, previous: prev } = d;
  const rate = engagement(cur);
  // Revenue stays a percentage at any size: a plain difference would have to say which currency.
  const revenue = pctChange(cur.totalRevenue, prev?.totalRevenue);
  return (
    <>
      <ModuleSection>
        <KpiRow>
          <Kpi label="Organic sessions" value={formatNumber(cur.sessions)} delta={quiet(d, countDelta(cur.sessions, prev?.sessions))} />
          <Kpi label="Engagement rate" value={formatPct(rate)} delta={quiet(d, deltaBetween(rate, engagement(prev), "points"))} />
          {hasKeyEvents(d) && <Kpi label="Key events" value={formatNumber(cur.keyEvents)} delta={quiet(d, countDelta(cur.keyEvents, prev?.keyEvents))} />}
          {hasRevenue(d) && <Kpi label="Revenue" value={usd(cur.totalRevenue)} delta={quiet(d, revenue == null ? null : changeDelta(revenue, "percent", "up"))} />}
        </KpiRow>
      </ModuleSection>
      {d.series.length > 0 && (
        <ModuleSection>
          <Trend points={d.series.map((r) => ({ date: r.date, value: r.sessions }))} label="Organic sessions" counts noun="day" height={120} table={false} />
        </ModuleSection>
      )}
    </>
  );
}

export const dashboard: DashboardModule<Ga4DashboardData> = {
  id: "ga4",
  label: "Analytics",
  href: "/ga4",
  setup: { text: "no Analytics data yet", href: "/ga4" },
  load,
  failures: analyticsFailures,
  describe,
  baseline: (d) => (d.previous ? `previous ${DAYS} days` : null),
  changes,
  View,
};
