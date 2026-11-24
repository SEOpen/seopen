import { compare, Kpi, KpiRow, ModuleSection, type DashboardModule } from "@/components/ui/module-card";
import { Trend } from "@/components/ui/trend";
import { countDelta } from "@/lib/brief";
import { formatDay, formatNumber, formatPct } from "@/lib/format";
import type { Project } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { listSnapshots, snapshotFailures } from "./api";

export interface BacklinksDashboardData {
  /** Latest snapshot date, "YYYY-MM-DD". */
  date: string;
  /** The snapshot before it, or null when there is only one. */
  previousDate: string | null;
  referringDomains: number;
  referringDomainsChange: number | null;
  backlinks: number;
  backlinksChange: number | null;
  /** Share of backlinks without rel=nofollow, 0–1. */
  dofollowShare: number | null;
  /** Provider spam score, 0–100. */
  spamScore: number | null;
  /** Referring domains per snapshot, oldest first. */
  series: { date: string; referringDomains: number }[];
}

/** Latest stored snapshot against the one before, plus up to 26 snapshots of history. Database reads only. */
async function load(project: Project): Promise<BacklinksDashboardData | null> {
  const snaps = await listSnapshots(projectScope(project), 26);
  const last = snaps.at(-1);
  if (!last) return null;
  const prev = snaps.at(-2) ?? null;
  return {
    date: last.date,
    previousDate: prev?.date ?? null,
    referringDomains: last.referringDomains,
    referringDomainsChange: prev ? last.referringDomains - prev.referringDomains : null,
    backlinks: last.backlinks,
    backlinksChange: prev ? last.backlinks - prev.backlinks : null,
    dofollowShare: last.dofollowShare,
    spamScore: last.spamScore,
    series: snaps.map((s) => ({ date: s.date, referringDomains: s.referringDomains })),
  };
}

function describe(d: BacklinksDashboardData) {
  return `As of ${formatDay(d.date)}`;
}

/** The count before a stored difference, or null with nothing earlier. */
const before = (now: number, change: number | null) => (change == null ? null : now - change);

function changes(d: BacklinksDashboardData) {
  return [
    compare("Referring domains", d.referringDomains, before(d.referringDomains, d.referringDomainsChange), { unit: "percent" }),
    compare("Backlinks", d.backlinks, before(d.backlinks, d.backlinksChange), { unit: "percent" }),
  ];
}

function View({ data: d }: { data: BacklinksDashboardData }) {
  return (
    <>
      <ModuleSection>
        <KpiRow>
          <Kpi label="Referring domains" value={formatNumber(d.referringDomains)} delta={countDelta(d.referringDomains, before(d.referringDomains, d.referringDomainsChange))} />
          <Kpi label="Backlinks" value={formatNumber(d.backlinks)} delta={countDelta(d.backlinks, before(d.backlinks, d.backlinksChange))} />
          <Kpi label="Followed links" value={formatPct(d.dofollowShare)} hint={`spam score ${d.spamScore ?? "–"}`} />
        </KpiRow>
      </ModuleSection>
      {d.series.length > 0 && (
        <ModuleSection>
          <Trend points={d.series.map((s) => ({ date: s.date, value: s.referringDomains }))} label="Referring domains" noun="snapshot" height={120} table={false} />
        </ModuleSection>
      )}
    </>
  );
}

export const dashboard: DashboardModule<BacklinksDashboardData> = {
  id: "backlinks",
  label: "Backlinks",
  href: "/backlinks",
  setup: { text: "no backlink snapshot yet", href: "/backlinks" },
  load,
  // The weekly snapshot that couldn't run, so the stored numbers are older than the last try.
  failures: (projects, timeZone) => snapshotFailures(projects[0].workspaceId, projects.map((p) => p.id), timeZone),
  describe,
  baseline: (d) => (d.previousDate ? formatDay(d.previousDate) : null),
  changes,
  View,
};
