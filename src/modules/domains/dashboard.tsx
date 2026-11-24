import { compare, Kpi, KpiRow, ModuleSection, type DashboardModule } from "@/components/ui/module-card";
import { Trend } from "@/components/ui/trend";
import { countDeltaFromZero } from "@/lib/brief";
import { formatDay, formatNumber, formatTimestamp, formatUsd } from "@/lib/format";
import type { Project } from "@/lib/projects";
import { projectScope, workspaceTimeZone } from "@/lib/workspace";
import { monthBefore, monthLabel } from "./brief";
import { latestSnapshots } from "./snapshot";

interface SnapshotKpis {
  /** Snapshot day, "YYYY-MM-DD". */
  date: string;
  keywords: number;
  traffic: number;
  top10: number;
}

export interface DomainsDashboardData {
  domain: string;
  latest: SnapshotKpis & { trafficValue: number };
  /** The month before the latest reading, from the monthly history Domain analysis compares with. Null when no history is stored. */
  previous: (Omit<SnapshotKpis, "date"> & { /** "YYYY-MM". */ month: string }) | null;
  /** Monthly estimated traffic, oldest first; months are "YYYY-MM". */
  history: { month: string; traffic: number }[];
}

/**
 * Organic KPIs from the last stored snapshots of the project's domain. Database reads only. The
 * comparison is against the monthly history, as on Domain analysis, so the two pages agree. Two
 * snapshots aren't comparable: a total read on one day can differ from the next read without any move.
 */
async function load(project: Project): Promise<DomainsDashboardData | null> {
  const snaps = await latestSnapshots(projectScope(project), 12);
  const [latest] = snaps;
  if (!latest) return null;
  // History is only stored when it was loaded; take the newest snapshot that has it.
  const history = snaps.find((s) => s.history?.length)?.history ?? [];
  // The day it was looked up in the workspace's zone, as Domain analysis's "Looked up" says it. The stored date is a UTC key.
  const timeZone = await workspaceTimeZone(project);
  const earlier = monthBefore(history, latest.createdAt);
  return {
    domain: latest.domain,
    latest: { date: formatTimestamp(latest.createdAt, timeZone).slice(0, 10), keywords: latest.keywords, traffic: latest.traffic, top10: latest.top10, trafficValue: latest.trafficValue },
    previous: earlier ? { month: earlier.date, keywords: earlier.keywords, traffic: earlier.traffic, top10: earlier.top10 } : null,
    history: history.map((h) => ({ month: h.date, traffic: h.traffic })),
  };
}

function describe(d: DomainsDashboardData) {
  return `Estimates for ${d.domain} · ${formatDay(d.latest.date)}`;
}

function changes({ latest: cur, previous: prev }: DomainsDashboardData) {
  return [compare("Keywords", cur.keywords, prev?.keywords, { count: true }), compare("Est. traffic", cur.traffic, prev?.traffic, { count: true }), compare("Top 10", cur.top10, prev?.top10, { count: true })];
}

function View({ data: d }: { data: DomainsDashboardData }) {
  const { latest: cur, previous: prev } = d;
  return (
    <>
      <ModuleSection>
        <KpiRow>
          <Kpi label="Keywords" value={formatNumber(cur.keywords)} delta={countDeltaFromZero(cur.keywords, prev?.keywords)} />
          <Kpi label="Est. traffic" value={formatNumber(cur.traffic)} delta={countDeltaFromZero(cur.traffic, prev?.traffic)} />
          <Kpi label="Top 10" value={formatNumber(cur.top10)} delta={countDeltaFromZero(cur.top10, prev?.top10)} />
          <Kpi label="Traffic value" value={formatUsd(Math.round(cur.trafficValue), 0)} />
        </KpiRow>
      </ModuleSection>
      {d.history.length > 0 && (
        <ModuleSection>
          <Trend points={d.history.map((h) => ({ date: `${h.month.slice(0, 7)}-01`, value: h.traffic }))} label="Est. traffic" noun="month" monthly height={120} table={false} />
        </ModuleSection>
      )}
    </>
  );
}

export const dashboard: DashboardModule<DomainsDashboardData> = {
  id: "domains",
  label: "Domain analysis",
  href: "/domains",
  setup: { text: "no domain snapshot yet", href: "/domains" },
  load,
  describe,
  // One lookup has nothing to compare against, but its chart can hold two years, so it doesn't say "nothing earlier".
  baseline: (d) => (d.previous ? monthLabel(d.previous.month) : d.history.length > 1 ? undefined : null),
  changes,
  View,
};
