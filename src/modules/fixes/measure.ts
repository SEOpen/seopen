import { and, between, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { fixes, gscDaily, gscPages, gscQueries, gscQueryPages, type FixMetrics, type FixResult } from "@/db/schema";
import { LIKELY_BOT_PATTERN } from "@/modules/google/bot-queries";
import { addDays, GSC_TIME_ZONE, todayIn } from "@/modules/google/windowing";
import { inScope, type ProjectScope } from "@/lib/workspace";
import { isSiteWide } from "./catalog";
import { CHECKPOINTS } from "./results";

type Fix = typeof fixes.$inferSelect;

/** The addresses Search Console may report one page under. */
export function pageVariants(url: string): string[] {
  try {
    const u = new URL(url);
    const bare = u.hostname.replace(/^www\./, "");
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : "/";
    const paths = path === "/" ? ["/"] : [path, `${path}/`];
    return ["https", "http"].flatMap((scheme) => [bare, `www.${bare}`].flatMap((host) => paths.map((p) => `${scheme}://${host}${p}${u.search}`)));
  } catch {
    return [url];
  }
}

/** The day a fix counts from: when it went live, or when it was marked applied if nothing could confirm that. */
export function anchorDay(fix: Pick<Fix, "liveAt" | "appliedAt">): string | null {
  const at = fix.liveAt ?? fix.appliedAt;
  return at ? todayIn(GSC_TIME_ZONE, at) : null;
}

const window = (start: string, end: string) => ({ start, end });

interface Sums {
  clicks: number;
  impressions: number;
  /** Position × impressions, so averages can be taken apart. */
  weighted: number;
}

/**
 * The stored numbers less searches that look like another tool's rank check (`LIKELY_BOT_PATTERN`),
 * the same rule `gscSeries` applies to the Search Console page, so a fix's result agrees with it.
 * When rounding leaves the average out of step with its rows, the stored average is kept.
 */
function lessRankChecks(all: Sums, bots: Sums | undefined): FixMetrics {
  const stored = all.impressions ? all.weighted / all.impressions : null;
  if (!bots?.impressions && !bots?.clicks) return { clicks: all.clicks, impressions: all.impressions, position: stored };
  const clicks = Math.max(0, all.clicks - bots.clicks);
  const impressions = Math.max(0, all.impressions - bots.impressions);
  const position = impressions ? (all.weighted - bots.weighted) / impressions : null;
  return { clicks, impressions, position: position === null ? null : position >= 1 ? position : stored };
}

const sums = <T extends { clicks: unknown; impressions: unknown; position: unknown }>(t: T) => ({
  clicks: sql<number>`coalesce(sum(${t.clicks}), 0)::int`,
  impressions: sql<number>`coalesce(sum(${t.impressions}), 0)::int`,
  weighted: sql<number>`coalesce(sum(${t.position} * ${t.impressions}), 0)::float`,
});

async function pageMetrics(scope: ProjectScope, url: string, r: { start: string; end: string }): Promise<FixMetrics> {
  const pages = pageVariants(url);
  const [[all], [bots]] = await Promise.all([
    db
      .select(sums(gscPages))
      .from(gscPages)
      .where(and(inScope(gscPages, scope), inArray(gscPages.page, pages), between(gscPages.date, r.start, r.end))),
    db
      .select(sums(gscQueryPages))
      .from(gscQueryPages)
      .where(and(inScope(gscQueryPages, scope), inArray(gscQueryPages.page, pages), between(gscQueryPages.date, r.start, r.end), sql`${gscQueryPages.query} ~ ${LIKELY_BOT_PATTERN}`)),
  ]);
  return all ? lessRankChecks(all, bots) : { clicks: 0, impressions: 0, position: null };
}

async function siteMetrics(scope: ProjectScope, r: { start: string; end: string }): Promise<FixMetrics> {
  const [[all], [bots]] = await Promise.all([
    db
      .select(sums(gscDaily))
      .from(gscDaily)
      .where(and(inScope(gscDaily, scope), between(gscDaily.date, r.start, r.end))),
    db
      .select(sums(gscQueries))
      .from(gscQueries)
      .where(and(inScope(gscQueries, scope), between(gscQueries.date, r.start, r.end), sql`${gscQueries.query} ~ ${LIKELY_BOT_PATTERN}`)),
  ]);
  return all ? lessRankChecks(all, bots) : { clicks: 0, impressions: 0, position: null };
}

/**
 * The checkpoints a fix has reached that Search Console has full data for. A checkpoint is skipped
 * for good if the data doesn't reach back over its "before" days: half a window isn't a comparison.
 */
export async function dueResults(scope: ProjectScope, fix: Fix, data: { first: string; last: string }, now = new Date()): Promise<Record<string, FixResult>> {
  const anchor = anchorDay(fix);
  if (!anchor) return {};
  const out: Record<string, FixResult> = {};
  for (const days of CHECKPOINTS) {
    if (fix.results?.[String(days)]) continue;
    const after = window(addDays(anchor, 1), addDays(anchor, days));
    const before = window(addDays(anchor, -days), addDays(anchor, -1));
    if (data.last < after.end || data.first > before.start) continue;
    const site = { before: await siteMetrics(scope, before), after: await siteMetrics(scope, after) };
    const wide = isSiteWide(fix.code);
    const b = wide ? site.before : await pageMetrics(scope, fix.url, before);
    const a = wide ? site.after : await pageMetrics(scope, fix.url, after);
    out[String(days)] = { days, before: { from: before.start, to: before.end, ...b }, after: { from: after.start, to: after.end, ...a }, site, computedAt: now.toISOString() };
  }
  return out;
}

/** Whether the last checkpoint has passed, whether or not there was data to measure it with. */
export function pastLastCheckpoint(fix: Pick<Fix, "liveAt" | "appliedAt">, data: { last: string }): boolean {
  const anchor = anchorDay(fix);
  return !!anchor && data.last >= addDays(anchor, CHECKPOINTS[CHECKPOINTS.length - 1]);
}
