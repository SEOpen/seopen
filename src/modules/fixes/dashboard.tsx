import { compare, Kpi, KpiRow, ModuleSection, type DashboardModule } from "@/components/ui/module-card";
import { countDelta } from "@/lib/brief";
import { canSeeFixReports } from "@/lib/billing/gates";
import { loadBillingWorkspace } from "@/lib/billing/workspace";
import { formatNumber } from "@/lib/format";
import type { Project } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { isSiteWide } from "./catalog";
import { fixCounts, fixResultLines, measuredFixes } from "./queries";
import { latestResult } from "./results";

export interface FixesDashboardData {
  open: number;
  /** Changed and being checked: applied and live. */
  inProgress: number;
  measured: number;
  /** "Fixed 12 titles on Nov 18. Clicks up 18% in 14 days.", newest first. Empty on Free. */
  lines: string[];
  /** Clicks on fixed pages over each one's longest checkpoint so far. Null with none measured, or on Free. */
  fixedPages: { clicks: number; previousClicks: number } | null;
}

async function load(project: Project): Promise<FixesDashboardData | null> {
  const scope = projectScope(project);
  const [counts, billing] = await Promise.all([fixCounts(scope), loadBillingWorkspace(project.workspaceId)]);
  if (!Object.values(counts).some(Boolean)) return null;
  const reports = canSeeFixReports(billing);
  const [lines, measured] = reports ? await Promise.all([fixResultLines(scope), measuredFixes(scope)]) : [[], []];
  // Two findings on one page share its numbers, so each page counts once. A site-wide fix (a missing
  // sitemap) stores the whole site's numbers, which aren't a page's.
  const pages = new Map(measured.filter((f) => !isSiteWide(f.code)).map((f) => [f.url, latestResult(f.results)]));
  let [clicks, previousClicks] = [0, 0];
  for (const r of pages.values()) {
    if (!r) continue;
    clicks += r.after.clicks;
    previousClicks += r.before.clicks;
  }
  return {
    open: counts.open,
    inProgress: counts.applied + counts.live,
    measured: counts.measured,
    lines: lines.slice(0, 3).map((l) => l.sentence),
    fixedPages: pages.size ? { clicks, previousClicks } : null,
  };
}

function describe(d: FixesDashboardData) {
  return d.open ? `${formatNumber(d.open)} to fix` : "Nothing new to fix";
}

function View({ data: d }: { data: FixesDashboardData }) {
  return (
    <>
      <ModuleSection>
        <KpiRow>
          <Kpi label="To fix" value={formatNumber(d.open)} />
          <Kpi label="Being checked" value={formatNumber(d.inProgress)} />
          {d.fixedPages ? <Kpi label="Clicks on fixed pages" value={formatNumber(d.fixedPages.clicks)} delta={countDelta(d.fixedPages.clicks, d.fixedPages.previousClicks)} /> : <Kpi label="Measured" value={formatNumber(d.measured)} />}
        </KpiRow>
      </ModuleSection>
      {d.lines.length > 0 && (
        <ModuleSection>
          <ul className="flex flex-col gap-1.5 text-sm text-secondary">
            {d.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </ModuleSection>
      )}
    </>
  );
}

export const dashboard: DashboardModule<FixesDashboardData> = {
  id: "fixes",
  label: "Fixes",
  href: "/fixes",
  setup: { text: "nothing found to fix yet", href: "/fixes" },
  load,
  describe,
  baseline: (d) => (d.fixedPages ? "the days before each fix" : null),
  changes: (d) => [compare("Clicks on fixed pages", d.fixedPages?.clicks, d.fixedPages?.previousClicks, { unit: "percent" })],
  View,
};
