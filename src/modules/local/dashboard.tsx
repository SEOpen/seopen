import { compare, Kpi, KpiRow, ModuleList, ModuleListItem, ModuleSection, type DashboardModule } from "@/components/ui/module-card";
import { deltaBetween } from "@/components/ui/what-changed";
import { formatDate, formatNumber } from "@/lib/format";
import type { Project } from "@/lib/projects";
import { projectScope, workspaceTimeZone } from "@/lib/workspace";
import type { CheckFailure } from "@/lib/check-failure";
import { localFailure, projectLocalFailure } from "./failure";
import { addStats, avgRank, EMPTY_STATS, foundShare, sameGrid, top3Share, type KeywordStats } from "./metrics";
import { checkStats, latestPair, listBusinesses, listChecks, listKeywords, newestChecks } from "./queries";

interface CheckSummary {
  /** When the newest check in this summary ran, ISO. */
  at: string;
  /** Average map rank where found, across every business and keyword. */
  avgRank: number | null;
  /** Share of answered points ranking 1–3. */
  top3: number | null;
  /** Share of answered points where the listing appears at all. */
  found: number | null;
  answered: number;
}

export interface LocalDashboardData {
  businesses: number;
  keywords: number;
  /** Whether any listing still gets the weekly check; each can be paused. */
  weekly: boolean;
  /** The workspace's zone, which the checks' `at` read in. */
  timeZone: string;
  latest: CheckSummary;
  /** Each business's check before its latest; null when none has two. */
  previous: CheckSummary | null;
  rows: { id: number; title: string; avgRank: number | null; found: string }[];
}

function summary(stats: KeywordStats, at: Date): CheckSummary {
  return { at: at.toISOString(), avgRank: avgRank(stats), top3: top3Share(stats), found: foundShare(stats), answered: stats.answered };
}

/** Latest and previous check per business, summed over its keywords. Database reads only. */
async function load(project: Project): Promise<LocalDashboardData | null> {
  const scope = projectScope(project);
  const businesses = await listBusinesses(scope);
  if (!businesses.length) return null;
  const ids = businesses.map((b) => b.id);
  const [keywords, checks] = await Promise.all([listKeywords(scope, ids), listChecks(scope, ids, 200)]);
  const pairs = businesses.map((b) => ({ b, ...latestPair(checks, b.id) })).filter((p) => p.latest);
  if (!pairs.length) return null;
  const stats = await checkStats(scope, pairs.flatMap((p) => [p.latest!.id, ...(p.previous ? [p.previous.id] : [])]));
  const sumFor = (checkId: number, businessId: number) =>
    addStats(keywords.filter((k) => k.businessId === businessId).map((k) => stats.get(`${checkId}:${k.id}`) ?? EMPTY_STATS));
  const latestStats = pairs.map((p) => sumFor(p.latest!.id, p.b.id));
  const prevPairs = pairs.filter((p) => p.previous);
  const newest = (cs: { createdAt: Date; finishedAt: Date | null }[]) => new Date(Math.max(...cs.map((c) => (c.finishedAt ?? c.createdAt).getTime())));
  return {
    businesses: businesses.length,
    keywords: keywords.length,
    weekly: businesses.some((b) => b.scheduled),
    timeZone: await workspaceTimeZone(project),
    latest: summary(addStats(latestStats), newest(pairs.map((p) => p.latest!))),
    previous: prevPairs.length ? summary(addStats(prevPairs.map((p) => sumFor(p.previous!.id, p.b.id))), newest(prevPairs.map((p) => p.previous!))) : null,
    rows: pairs.map((p, i) => {
      const s = latestStats[i];
      return { id: p.b.id, title: p.b.title, avgRank: avgRank(s), found: `${s.found}/${s.answered}` };
    }),
  };
}

function describe(d: LocalDashboardData) {
  return `${formatNumber(d.businesses)} ${d.businesses === 1 ? "listing" : "listings"} · ${formatNumber(d.keywords)} keywords · last check ${formatDate(d.latest.at, d.timeZone)}`;
}

/** A share of a check's answered points as Local SEO says it: "15 of 150". */
const ofPoints = (share: number | null, answered: number) => (share == null ? "–" : `${formatNumber(Math.round(share * answered))} of ${formatNumber(answered)}`);

/** How many of a check's answered points a share is. */
const pointsOf = (share: number | null, answered: number) => (share == null ? null : Math.round(share * answered));

function changes({ latest: cur, previous: prev }: LocalDashboardData) {
  // A change is only listed when the two shares differ, so a share says which check's total it's out of.
  const points = (key: "top3" | "found") => (n: number) => ofPoints(n, n === cur[key] ? cur.answered : (prev?.answered ?? cur.answered));
  const share = (label: string, key: "top3" | "found") =>
    sameGrid(cur, prev)
      ? compare(label, pointsOf(cur[key], cur.answered), pointsOf(prev[key], prev.answered), { unit: "number", format: (n) => `${formatNumber(n)} of ${formatNumber(cur.answered)}` })
      : compare(label, cur[key], prev?.[key], { unit: "points", format: points(key) });
  return [compare("Avg. map rank", cur.avgRank, prev?.avgRank, { unit: "decimal", goodWhen: "down", format: (n) => n.toFixed(1), rank: true }), share("Top 3", "top3"), share("Points found", "found")];
}

/** The Kpi's change for a share, in the unit `changes` gives it. */
function shareDelta(cur: CheckSummary, prev: CheckSummary | null, key: "top3" | "found") {
  if (!sameGrid(cur, prev)) return deltaBetween(cur[key], prev?.[key], "points");
  return deltaBetween(pointsOf(cur[key], cur.answered), pointsOf(prev[key], prev.answered), "number");
}

function View({ data: d }: { data: LocalDashboardData }) {
  const { latest: cur, previous: prev } = d;
  return (
    <>
      <ModuleSection>
        <KpiRow>
          <Kpi label="Avg. map rank" value={cur.avgRank == null ? "–" : cur.avgRank.toFixed(1)} delta={deltaBetween(cur.avgRank, prev?.avgRank, "decimal", "down", true)} />
          <Kpi label="Top 3" value={ofPoints(cur.top3, cur.answered)} delta={shareDelta(cur, prev, "top3")} />
          <Kpi label="Points found" value={ofPoints(cur.found, cur.answered)} delta={shareDelta(cur, prev, "found")} />
        </KpiRow>
      </ModuleSection>
      {d.rows.length > 1 && (
        <ModuleSection>
          <ModuleList>
            {d.rows.slice(0, 5).map((r) => (
              <ModuleListItem
                key={r.id}
                href={`/local/${r.id}`}
                label={r.title}
                meta={`${r.avgRank == null ? "not found" : `avg ${r.avgRank.toFixed(1)}`} · ${r.found} points`}
              />
            ))}
          </ModuleList>
        </ModuleSection>
      )}
    </>
  );
}

/** Projects with a business whose newest check failed, read together. Database reads only. */
async function failures(projects: Project[], timeZone: string) {
  const checks = await newestChecks(projects[0].workspaceId, projects.map((p) => p.id));
  const byProject = new Map<number, CheckFailure[]>();
  for (const check of checks) {
    const failure = localFailure(check, check.businessId, timeZone);
    if (failure) byProject.set(check.projectId, [...(byProject.get(check.projectId) ?? []), failure]);
  }
  return new Map([...byProject].map(([id, list]) => [id, projectLocalFailure(list)!] as const));
}

export const dashboard: DashboardModule<LocalDashboardData> = {
  id: "local",
  label: "Local SEO",
  href: "/local",
  setup: { text: "no Google Maps listing tracked yet", href: "/local" },
  load,
  failures,
  describe,
  baseline: (d) => (d.previous ? formatDate(d.previous.at, d.timeZone) : null),
  changes,
  View,
};
