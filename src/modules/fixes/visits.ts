import { and, between, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { ga4LandingDaily, projects, type FixResult } from "@/db/schema";
import { ga4DataRange } from "@/modules/google/data";
import { pageKey } from "@/modules/google/matching";
import { getPlausibleSyncState } from "@/modules/plausible/sync";
import { getUmamiSyncState } from "@/modules/umami/sync";
import { inScope, type ProjectScope } from "@/lib/workspace";
import { isSiteWide } from "./catalog";

/**
 * Plausible's or Umami's visits over the same days as a fix's Search Console numbers.
 * Read when a report shows, not stored with the result, so a site connected after a checkpoint still
 * gets them from its backfill, and they go when the project leaves the source and its rows are cleared.
 */

/** The sources whose visits a fix report shows. */
export type VisitsSource = "plausible" | "umami";

export interface CheckpointVisits {
  before: number;
  after: number;
  /** "page" for the fixed page, "site" for a fix that reads the whole site. */
  over: "page" | "site";
}

type Row = { id: number; code: string; url: string; results: Record<string, FixResult> | null };

const decoded = (path: string) => {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
};

/** A fixed page's address, as a key that matches however Plausible and Search Console spell it. */
const visitKey = (url: string) => decoded(pageKey(url));

/** The entry paths a fixed page may be stored under. */
function pathsOf(url: string): string[] {
  const key = visitKey(url);
  const slash = key.indexOf("/");
  const path = slash < 0 ? "/" : key.slice(slash);
  return [...new Set([path, encodeURI(path)].flatMap((p) => (p === "/" ? ["/"] : [p, `${p}/`])))];
}

const sum = (byDay: Map<string, number>, from: string, to: string) => {
  let total = 0;
  for (const [day, n] of byDay) if (day >= from && day <= to) total += n;
  return total;
};

/** Plausible's visits per fix and checkpoint, when Plausible is the project's source. */
export const plausibleVisits = (scope: ProjectScope, rows: Row[]) => sourceVisits(scope, rows, "plausible");

/** Umami's, when Umami is. */
export const umamiVisits = (scope: ProjectScope, rows: Row[]) => sourceVisits(scope, rows, "umami");

/** The visits of whichever of the two the project reads from, and which it is. Empty for any other source. */
export async function organicVisits(scope: ProjectScope, rows: Row[]): Promise<{ source: VisitsSource; visits: Map<number, Record<string, CheckpointVisits>> }> {
  const [p] = await db
    .select({ umami: projects.umamiSite })
    .from(projects)
    .where(and(eq(projects.workspaceId, scope.workspaceId), eq(projects.id, scope.projectId)));
  const source: VisitsSource = p?.umami ? "umami" : "plausible";
  return { source, visits: await sourceVisits(scope, rows, source) };
}

/**
 * A source's visits per fix and checkpoint, when it's the project's source. A checkpoint is
 * left out unless the sync has reached all its days and the site's history starts by its first day,
 * because a day not synced or from before the site was tracked isn't a day with no visits.
 */
async function sourceVisits(scope: ProjectScope, rows: Row[], source: VisitsSource): Promise<Map<number, Record<string, CheckpointVisits>>> {
  const out = new Map<number, Record<string, CheckpointVisits>>();
  const measured = rows.filter((r) => r.results && Object.keys(r.results).length);
  if (!measured.length) return out;
  const [project] = await db
    .select({ site: source === "umami" ? projects.umamiSite : projects.plausibleSite })
    .from(projects)
    .where(and(eq(projects.workspaceId, scope.workspaceId), eq(projects.id, scope.projectId)));
  if (!project?.site) return out;
  const [state, data] = await Promise.all([source === "umami" ? getUmamiSyncState(scope) : getPlausibleSyncState(scope), ga4DataRange(scope)]);
  if (!state?.latestDate || state.property !== project.site || !data) return out;
  const { latestDate, backfillDone, backfillCursor } = state;
  const covered = (r: FixResult) => data.first <= r.before.from && r.after.to <= latestDate && (backfillDone || (!!backfillCursor && r.after.to < backfillCursor));

  const usable = measured.map((f) => ({ ...f, checkpoints: Object.values(f.results!).filter(covered) })).filter((f) => f.checkpoints.length);
  if (!usable.length) return out;
  const from = usable.flatMap((f) => f.checkpoints.map((c) => c.before.from)).sort()[0];
  const to = usable.flatMap((f) => f.checkpoints.map((c) => c.after.to)).sort().at(-1)!;
  const inRange = and(inScope(ga4LandingDaily, scope), between(ga4LandingDaily.date, from, to));
  const sessions = sql<number>`coalesce(sum(${ga4LandingDaily.sessions}), 0)::int`;
  const paged = usable.filter((f) => !isSiteWide(f.code));
  const [pageRows, siteRows] = await Promise.all([
    paged.length
      ? db
          .select({ date: ga4LandingDaily.date, hostName: ga4LandingDaily.hostName, landingPage: ga4LandingDaily.landingPage, sessions })
          .from(ga4LandingDaily)
          .where(and(inRange, inArray(ga4LandingDaily.landingPage, [...new Set(paged.flatMap((f) => pathsOf(f.url)))])))
          .groupBy(ga4LandingDaily.date, ga4LandingDaily.hostName, ga4LandingDaily.landingPage)
      : [],
    paged.length < usable.length ? db.select({ date: ga4LandingDaily.date, sessions }).from(ga4LandingDaily).where(inRange).groupBy(ga4LandingDaily.date) : [],
  ]);

  const site = new Map(siteRows.map((r) => [r.date, r.sessions]));
  const pages = new Map<string, Map<string, number>>();
  for (const r of pageRows) {
    const key = decoded(pageKey(r.hostName, r.landingPage));
    const days = pages.get(key) ?? new Map<string, number>();
    days.set(r.date, (days.get(r.date) ?? 0) + r.sessions);
    pages.set(key, days);
  }
  const none = new Map<string, number>();
  for (const f of usable) {
    const wide = isSiteWide(f.code);
    const days = wide ? site : (pages.get(visitKey(f.url)) ?? none);
    out.set(f.id, Object.fromEntries(f.checkpoints.map((c) => [String(c.days), { before: sum(days, c.before.from, c.before.to), after: sum(days, c.after.from, c.after.to), over: wide ? ("site" as const) : ("page" as const) }])));
  }
  return out;
}
