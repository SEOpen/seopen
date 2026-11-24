import { compare, Kpi, KpiRow, ModuleSection, type DashboardModule } from "@/components/ui/module-card";
import { deltaBetween } from "@/components/ui/what-changed";
import { countDelta, rateDelta } from "@/lib/brief";
import { formatDay, formatNumber, formatRate } from "@/lib/format";
import type { Project } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { gscDataRange, gscSeries, gscTotals, type Totals } from "./data";
import { searchConsoleFailures } from "./failure";
import { comparesFairly } from "./ga4-brief";
import { eachDay, maxDate, resolvePeriods, storedDays } from "./windowing";

const DAYS = 28;

export interface GoogleDashboardData {
  /** Last day of the 28-day window, "YYYY-MM-DD". */
  end: string;
  current: Totals;
  /** The 28 days before, or null unless stored history covers all of them. */
  previous: Totals | null;
  /**
   * Daily clicks and impression-weighted position, for every stored day of the window, oldest first. A
   * stored day with no impressions is 0 clicks and a null position, so the first entry is where history
   * starts even on a quiet site.
   */
  series: { date: string; clicks: number; position: number | null }[];
}

/** Last 28 days of stored Search Console data against the 28 before. Database reads only. */
async function load(project: Project): Promise<GoogleDashboardData | null> {
  if (!project.gscProperty) return null;
  const range = await gscDataRange(projectScope(project));
  if (!range) return null;
  const periods = resolvePeriods(range.last, DAYS, "prev");
  const { current } = periods;
  // A part-stored earlier period would sum a few days against 28 and read as a huge rise.
  const previous = comparesFairly(periods, range.first) ? periods.previous : null;
  const [cur, prev, rows] = await Promise.all([
    gscTotals(projectScope(project), current),
    previous ? gscTotals(projectScope(project), previous) : null,
    gscSeries(projectScope(project), current),
  ]);
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const series = eachDay({ start: maxDate(range.first, current.start), end: range.last }).map((date) => {
    const r = byDate.get(date);
    return { date, clicks: r?.clicks ?? 0, position: r && r.impressions > 0 ? r.position : null };
  });
  return { end: range.last, current: cur, previous: prev, series };
}

function describe(d: GoogleDashboardData) {
  const days = storedDays(d, DAYS);
  return `${days} day${days === 1 ? "" : "s"} to ${formatDay(d.end)}`;
}

// Position is impression-weighted; with no impressions it means nothing.
const position = (t: Totals | null) => (t && t.impressions > 0 ? t.position : null);

function changes(d: GoogleDashboardData) {
  const { current: cur, previous: prev } = d;
  const volume = prev ? Math.min(cur.impressions, prev.impressions) : null;
  return [
    compare("Clicks", cur.clicks, prev?.clicks, { unit: "percent" }),
    compare("Impressions", cur.impressions, prev?.impressions, { unit: "percent" }),
    compare("CTR", cur.ctr, prev?.ctr, { unit: "points", format: (n) => formatRate(n), volume }),
    compare("Search Console position", position(cur), position(prev), { unit: "decimal", goodWhen: "down", format: (n) => n.toFixed(1), rank: true, volume }),
  ];
}

function View({ data: d }: { data: GoogleDashboardData }) {
  const { current: cur, previous: prev } = d;
  const pos = position(cur);
  return (
    <>
      <ModuleSection>
        <KpiRow>
          <Kpi label="Impressions" value={formatNumber(cur.impressions)} delta={countDelta(cur.impressions, prev?.impressions)} />
          <Kpi label="CTR" value={formatRate(cur.ctr)} delta={prev ? rateDelta(cur.ctr, prev.ctr) : null} />
          <Kpi label="Search Console position" value={pos == null ? "–" : pos.toFixed(1)} delta={deltaBetween(pos, position(prev), "decimal", "down", true)} />
        </KpiRow>
      </ModuleSection>
    </>
  );
}

export const dashboard: DashboardModule<GoogleDashboardData> = {
  id: "google",
  label: "Search Console",
  href: "/gsc",
  setup: { text: "no Search Console data yet", href: "/gsc" },
  load,
  failures: searchConsoleFailures,
  describe,
  baseline: (d) => (d.previous ? `previous ${DAYS} days` : null),
  changes,
  View,
};
