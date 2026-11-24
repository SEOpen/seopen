import type { FixMetrics, FixResult } from "@/db/schema/fixes";
import { formatShortDate } from "@/lib/format";
import { addDays, GSC_TIME_ZONE, todayIn } from "@/modules/google/windowing";
import { fixDef, isManualCode, isSiteWide } from "./catalog";

/**
 * What a fix did, in words that only claim what the numbers show. Pure: `measure.ts` reads
 * the numbers. Each checkpoint compares the N days after a fix went live with the N days before it,
 * beside the whole site over the same days, because a season or an update moves everything.
 */

/** Days after going live. */
export const CHECKPOINTS = [7, 14, 28] as const;
/** Clicks across both windows before a percentage means anything. */
const MIN_CLICKS = 20;
/** Impressions across both windows, when there are too few clicks to read. */
const MIN_IMPRESSIONS = 200;
/** A move inside this is noise. */
const FLAT = 0.05;

export type Direction = "up" | "down" | "flat" | "too_little_data";

export interface ResultReading {
  metric: "clicks" | "impressions" | null;
  direction: Direction;
  /** Whole percent, signed; null without a comparison. */
  change: number | null;
  from: number;
  to: number;
  /** The whole site's change in the same metric, whole percent. */
  siteChange: number | null;
}

const pct = (from: number, to: number) => (from > 0 ? Math.round(((to - from) / from) * 100) : null);

export function readResult(before: FixMetrics, after: FixMetrics, site: { before: FixMetrics; after: FixMetrics }): ResultReading {
  const clicks = before.clicks + after.clicks >= MIN_CLICKS;
  const impressions = before.impressions + after.impressions >= MIN_IMPRESSIONS;
  if (!clicks && !impressions) return { metric: null, direction: "too_little_data", change: null, from: before.clicks, to: after.clicks, siteChange: null };
  const metric = clicks ? "clicks" : "impressions";
  const [from, to] = [before[metric], after[metric]];
  const siteChange = pct(site.before[metric], site.after[metric]);
  if (from === 0) return { metric, direction: to > 0 ? "up" : "flat", change: null, from, to, siteChange };
  const raw = (to - from) / from;
  return { metric, direction: Math.abs(raw) < FLAT ? "flat" : raw > 0 ? "up" : "down", change: Math.round(raw * 100), from, to, siteChange };
}

const label = (metric: "clicks" | "impressions") => (metric === "clicks" ? "Clicks" : "Impressions");

/** "Clicks up 18% in 14 days, from 40 to 47, while the whole site rose 3%." Never credits the fix with more than that. */
export function resultSentence(r: ResultReading, days: number): string {
  if (r.direction === "too_little_data" || !r.metric) return `Too little traffic in ${days} days to tell.`;
  const name = label(r.metric);
  const site = r.siteChange == null ? "" : `, while the whole site ${r.siteChange > 0 ? `rose ${r.siteChange}%` : r.siteChange < 0 ? `fell ${-r.siteChange}%` : "held level"}`;
  if (r.direction === "flat") return `${name} held about level in ${days} days, at ${r.to.toLocaleString("en-US")}${site}. No clear change yet.`;
  const size = r.change == null ? `from none to ${r.to.toLocaleString("en-US")}` : `${Math.abs(r.change)}%`;
  const fromTo = r.change == null ? "" : `, from ${r.from.toLocaleString("en-US")} to ${r.to.toLocaleString("en-US")}`;
  return `${name} ${r.direction} ${size} in ${days} days${fromTo}${site}.`;
}

const day = (d: string) => formatShortDate(d, "UTC");

/**
 * When a fix being checked gets its numbers, for its row. The days are Search Console's, as
 * `measure.ts` counts them: a checkpoint waits until Search Console has data to its last day.
 */
export function measuringLine(fix: { status: string; liveAt: Date | null; appliedAt: Date | null; liveCheck: { state: string } | null; code?: string }): string | null {
  if (fix.status !== "applied" && fix.status !== "live") return null;
  const unseen = fix.status === "applied" && fix.liveCheck?.state === "cannot_check";
  const at = fix.status === "live" ? (fix.liveAt ?? fix.appliedAt) : unseen ? fix.appliedAt : null;
  // A logged change has no finding for a crawl to stop finding.
  if (!at) return fix.code && isManualCode(fix.code) ? "Measuring starts on the day the change shows on the live page." : "Measuring starts on the day the change shows on the live page, or the next crawl stops finding it.";
  const anchor = todayIn(GSC_TIME_ZONE, at);
  const from = fix.status === "live" ? `Measured from ${day(anchor)}, the day it was seen live.` : `Measured from ${day(anchor)}, the day it was marked changed, because SEOpen can't see this change on the page.`;
  return `${from} The ${CHECKPOINTS[0]}-day result shows once Search Console has data to ${day(addDays(anchor, CHECKPOINTS[0]))}, and the ${CHECKPOINTS.at(-1)}-day one once it has ${day(addDays(anchor, CHECKPOINTS.at(-1)!))}.`;
}

/** What "Plausible organic visits" counts, in full, wherever the number shows. */
export const VISITS_MEANING = "Plausible organic visits are visits that started on the page and that Plausible files under Organic Search: people arriving from any search site it knows, plus links tagged with the medium organic. That isn't only Google, so they won't match Search Console's clicks.";

/** What "Umami organic visits" counts. Shown only on a project already reading from Umami. */
export const UMAMI_VISITS_MEANING = "Umami organic visits are visits that started on the page and arrived from a search site: Google, Bing, DuckDuckGo, Ecosia, Yandex, Baidu, Brave Search or MSN. That isn't only Google, so they won't match Search Console's clicks, and Umami's days are UTC.";

/** The meaning line for a source's visits. */
export const visitsMeaning = (source: "plausible" | "umami") => (source === "umami" ? UMAMI_VISITS_MEANING : VISITS_MEANING);

/** "14 days before and after: Search Console clicks 40, then 47. Plausible organic visits 52, then 61." Numbers only, with no claim about the fix. */
export function visitsSentence(result: Pick<FixResult, "days" | "before" | "after">, visits: { before: number; after: number; over: "page" | "site" }, source: "plausible" | "umami" = "plausible"): string {
  const n = (v: number) => v.toLocaleString("en-US");
  const where = visits.over === "site" ? ", across the whole site" : "";
  return `${result.days} days before and after${where}: Search Console clicks ${n(result.before.clicks)}, then ${n(result.after.clicks)}. ${source === "umami" ? "Umami" : "Plausible"} organic visits ${n(visits.before)}, then ${n(visits.after)}.`;
}

export function readStored(result: FixResult): ResultReading {
  return readResult(result.before, result.after, result.site);
}

/** The longest checkpoint measured so far. */
export function latestResult(results: Record<string, FixResult> | null | undefined): FixResult | null {
  const days = Object.keys(results ?? {}).map(Number).sort((a, b) => b - a)[0];
  return days ? results![String(days)] : null;
}

export interface MeasuredFix {
  id: number;
  code: string;
  url: string;
  /** "YYYY-MM-DD". */
  liveDay: string;
  results: Record<string, FixResult> | null;
}

export interface ResultLine {
  noun: string;
  count: number;
  liveDay: string;
  days: number;
  reading: ResultReading;
  sentence: string;
}

/** "Nov 18": a results line is about recent work, so the year adds nothing. */
const shortDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const add = (a: FixMetrics, b: FixMetrics): FixMetrics => ({ clicks: a.clicks + b.clicks, impressions: a.impressions + b.impressions, position: null });
const ZERO: FixMetrics = { clicks: 0, impressions: 0, position: null };

/**
 * "Fixed 12 titles on Nov 18. Clicks up 18% in 14 days." Fixes of one kind that went live on one day
 * read together at the longest checkpoint all of them have, counting each page once. Newest first.
 */
export function resultLines(fixes: MeasuredFix[]): ResultLine[] {
  const groups = new Map<string, MeasuredFix[]>();
  for (const f of fixes) {
    if (!latestResult(f.results)) continue;
    const def = fixDef(f.code);
    // The verb is in the key, so logged changes ("Changed 3 pages") never fold into fixes of pages.
    const key = `${def.verb ?? "Fixed"}|${def.noun[1]}|${f.liveDay}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  const lines: ResultLine[] = [];
  for (const group of groups.values()) {
    const days = Math.min(...group.map((f) => latestResult(f.results)!.days));
    const pages = new Map(group.map((f) => [f.url, f.results?.[String(days)]]));
    let [before, after] = [ZERO, ZERO];
    for (const r of pages.values()) {
      if (!r) continue;
      before = add(before, r.before);
      after = add(after, r.after);
    }
    const first = [...pages.values()].find(Boolean)!;
    const reading = readResult(before, after, first.site);
    const { noun: [one, many], verb = "Fixed" } = fixDef(group[0].code);
    const noun = group.length === 1 ? one : many;
    const allSite = group.every((f) => isSiteWide(f.code));
    const fixedOn = `${verb} ${group.length} ${noun} on ${shortDay(group[0].liveDay)}.`;
    lines.push({
      noun,
      count: group.length,
      liveDay: group[0].liveDay,
      days,
      reading,
      // A site-wide fix's numbers are the site's, so comparing them with the site says nothing.
      sentence: `${fixedOn} ${resultSentence(allSite ? { ...reading, siteChange: null } : reading, days)}`,
    });
  }
  return lines.sort((a, b) => b.liveDay.localeCompare(a.liveDay));
}
