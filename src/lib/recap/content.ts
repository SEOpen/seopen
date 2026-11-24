import { clicksThisWeek } from "@/app/(app)/dashboard-headlines";
import { chartDay, countChange, describeChange, magnitude, type AnyDashboardModule } from "@/components/ui/module-card";
import { changeWeight, enoughData, pickHighlights, type Highlight } from "@/components/ui/what-changed";
import { MIN_WEIGHT } from "@/lib/brief";
import { formatNumber } from "@/lib/format";
import type { AiDashboardData } from "@/modules/ai/dashboard";
import type { AuditDashboardData } from "@/modules/audit/dashboard";
import { searchConsoleSpan, urlPath } from "@/modules/google/brief";
import type { GoogleDashboardData } from "@/modules/google/dashboard";
import { daysBetween, type DateRange } from "@/modules/google/windowing";
import type { RankDashboardData } from "@/modules/rank/dashboard";

/**
 * What a project's weekly recap says. Pure, so every case is tested without a
 * database. It reads the cards the MCP's what_changed reads, and picks the same changes the app's
 * "What changed" does (pickHighlights), with each line saying what it's compared with. Only data
 * from the past week counts: an old crawl's change was news in an earlier recap, not this one. A
 * section also lists the pages closest to page one, as Opportunities scores them.
 */

/** The dashboard cards a recap reads, by module id. */
export const RECAP_MODULES = ["google", "rank", "ai", "audit"] as const;

/** A card that loaded, whose newest check didn't fail. A failed source has nothing new to say, as on Overview. */
export interface RecapSource {
  module: AnyDashboardModule;
  data: unknown;
}

export interface RecapProject {
  id: number;
  name: string;
  domain: string;
}

/** Fixes still open, and how many of them were first found in the past 7 days. */
export interface RecapFixes {
  open: number;
  newThisWeek: number;
}

/** The pages closest to page one (`gscStrikingPages`), best score first, each with its top search. */
export interface RecapClosest {
  period: DateRange;
  pages: { url: string; query: string; position: number; impressions: number }[];
}

/** An alert found in the past week (src/modules/alerts). `day` is the day it was found, in the workspace's zone. */
export interface RecapAlert {
  title: string;
  source: string;
  day: string;
  resolved: boolean;
}

export interface RecapLine {
  text: string;
  /** What it's compared with, as the app says it: "vs Oct 20", "vs previous run". */
  against: string;
  tone: "good" | "bad" | "neutral";
}

export interface ProjectRecap {
  project: RecapProject;
  /** The project's Overview. Opening it makes it the current project, so its pages follow. */
  href: string;
  lines: RecapLine[];
  /** Up to 3 pages closest to page one, or none. They don't make a section on their own. */
  closest: { heading: string; lines: RecapLine[] } | null;
  /** The week's alerts, newest first, or none. They make a section on their own. */
  alerts: { heading: string; lines: RecapLine[] } | null;
}

/** How many close pages a recap lists. */
export const CLOSEST_PAGES = 3;

/** How many of the week's alerts a recap lists; the heading counts them all. */
export const RECAP_ALERTS = 5;

const DAY_MS = 86_400_000;
const WEEK = 7;
/** Search Console's data runs two or three days behind, so its week can end a few days back. */
const SEARCH_CONSOLE_LAG = 3;

const utcDay = (now: Date) => now.toISOString().slice(0, 10);

/** Whether a card's newest data is from the past week. */
function fresh(source: RecapSource, now: Date): boolean {
  const today = utcDay(now);
  const within = (at: string) => now.getTime() - new Date(at).getTime() <= WEEK * DAY_MS;
  switch (source.module.id) {
    case "google":
      return daysBetween((source.data as GoogleDashboardData).end, today) <= WEEK + SEARCH_CONSOLE_LAG;
    case "rank":
      return daysBetween((source.data as RankDashboardData).latest.date, today) <= WEEK;
    case "ai":
      return within((source.data as AiDashboardData).lastRunAt);
    case "audit": {
      const latest = (source.data as AuditDashboardData).latest;
      return !!latest && within(latest.finishedAt);
    }
    default:
      return false;
  }
}

/** Search Console clicks over the latest 7 stored days against the 7 before, as the Overview's first row reads them. */
function clicksLine(d: GoogleDashboardData): RecapLine | null {
  const week = clicksThisWeek(d);
  if (week.previous == null || week.days < WEEK) return null;
  const change = { from: week.previous, to: week.current, unit: "percent" as const };
  const { value, unit } = countChange(week.current, week.previous);
  const { tone } = describeChange(value, unit, "up");
  if (tone === "muted" || !enoughData(change) || changeWeight(change) < MIN_WEIGHT) return null;
  return {
    text: `Search Console clicks ${value > 0 ? "up" : "down"} ${magnitude(Math.abs(value), unit)} in the last ${WEEK} days, from ${formatNumber(week.previous)} to ${formatNumber(week.current)}`,
    against: `to ${chartDay(d.end)}, vs the ${WEEK} days before`,
    tone,
  };
}

/** The Rankings average against the check about a week before, as the Overview's second row reads it: any move counts. */
function positionLine(d: RankDashboardData): RecapLine | null {
  const pos = d.latest.avgPosition;
  const prev = d.previous?.avgPosition;
  if (pos == null || prev == null || !d.previous) return null;
  const { tone } = describeChange(pos - prev, "decimal", "down");
  if (tone === "muted") return null;
  const amount = magnitude(Math.abs(pos - prev), "decimal");
  return {
    text: `Tracked position ${tone === "good" ? "improved" : "slipped"} ${amount} place${amount === "1" ? "" : "s"}, from ${prev.toFixed(1)} to ${pos.toFixed(1)}`,
    against: `vs ${chartDay(d.previous.date)}`,
    tone,
  };
}

/** Changes the fixed lines already say, so the highlights don't repeat them. */
const FIXED_LINES: ReadonlySet<string> = new Set(["rank:Tracked position"]);

/** "8 of 40", or with the earlier total when prompts came or went. */
const ofTotal = (n: number, total: number) => `${formatNumber(n)} of ${formatNumber(total)}`;

/** A highlight as a sentence. AI visibility is the share of answers naming the site, so it's said in answers. */
function highlightLine(h: Highlight, sources: RecapSource[]): RecapLine {
  const against = `vs ${h.baseline.replace(/, \d{4}$/, "")}`;
  const tone = h.tone;
  if (h.key === "ai:AI visibility") {
    const d = sources.find((s) => s.module.id === "ai")?.data as AiDashboardData | undefined;
    if (d?.previous) {
      const { current: cur, previous: prev } = d;
      const from = prev.total === cur.total ? formatNumber(prev.mentioned) : ofTotal(prev.mentioned, prev.total);
      return { text: `AI answers naming you ${h.verb}, from ${from} to ${ofTotal(cur.mentioned, cur.total)}`, against, tone };
    }
  }
  return { text: `${h.label} ${h.verb} ${h.amount}, from ${h.from} to ${h.to}`, against, tone };
}

function fixesLine(f: RecapFixes): RecapLine | null {
  if (!f.open) return null;
  const week = `in the last ${WEEK} days`;
  if (!f.newThisWeek) return { text: `${formatNumber(f.open)} fix${f.open === 1 ? "" : "es"} still open`, against: `none new ${week}`, tone: "neutral" };
  return { text: `${formatNumber(f.newThisWeek)} new fix${f.newThisWeek === 1 ? "" : "es"} to make, ${formatNumber(f.open)} open in all`, against: `found ${week}`, tone: "bad" };
}

/** "3 pages closest to page one", each with its top search, its position and its impressions, from a fresh period only. */
function closestBlock(c: RecapClosest | null | undefined, now: Date): ProjectRecap["closest"] {
  if (!c?.pages.length || daysBetween(c.period.end, utcDay(now)) > WEEK + SEARCH_CONSOLE_LAG) return null;
  const pages = c.pages.slice(0, CLOSEST_PAGES);
  const against = searchConsoleSpan(c.period);
  return {
    heading: pages.length === 1 ? "The page closest to page one" : `${pages.length} pages closest to page one`,
    lines: pages.map((p) => ({ text: `${urlPath(p.url)}: “${p.query}” at position ${p.position}, ${formatNumber(p.impressions)} impression${p.impressions === 1 ? "" : "s"}`, against, tone: "neutral" })),
  };
}

/** "2 alerts this week", each with where it came from and the day, and whether it's fixed since. */
function alertsBlock(list: RecapAlert[] | null | undefined): ProjectRecap["alerts"] {
  if (!list?.length) return null;
  const shown = list.slice(0, RECAP_ALERTS);
  const more = list.length - shown.length;
  return {
    heading: `${formatNumber(list.length)} alert${list.length === 1 ? "" : "s"} this week${more ? `, the latest ${shown.length}` : ""}`,
    lines: shown.map((a) => ({ text: a.title, against: `${a.source}, ${chartDay(a.day)}${a.resolved ? ", fixed since" : ""}`, tone: a.resolved ? "neutral" : "bad" })),
  };
}

/**
 * A project's section, or null when it has nothing to say: no card moved this week, no new fix
 * came in and no alert fired. Open fixes alone don't make a section, since they'd repeat every week until they're made.
 */
export function projectRecap(o: { project: RecapProject; sources: RecapSource[]; fixes: RecapFixes; closest?: RecapClosest | null; alerts?: RecapAlert[] | null; now: Date; origin: string }): ProjectRecap | null {
  const sources = o.sources.filter((s) => (RECAP_MODULES as readonly string[]).includes(s.module.id) && fresh(s, o.now));
  const data = <D,>(id: string) => sources.find((s) => s.module.id === id)?.data as D | undefined;
  const google = data<GoogleDashboardData>("google");
  const ranks = data<RankDashboardData>("rank");
  const fixed = [google && clicksLine(google), ranks && positionLine(ranks)].filter((l): l is RecapLine => !!l);
  // Search Console's own changes are over 28 days; the recap's clicks line is the week's.
  const { worse, better } = pickHighlights(sources.filter((s) => s.module.id !== "google"), FIXED_LINES);
  const moves = [...fixed, ...[...worse, ...better].map((h) => highlightLine(h, sources))];
  const alerts = alertsBlock(o.alerts);
  if (!moves.length && !o.fixes.newThisWeek && !alerts) return null;
  const fixes = fixesLine(o.fixes);
  return { project: o.project, href: `${o.origin}/projects/${o.project.id}`, lines: [...moves, ...(fixes ? [fixes] : [])], closest: closestBlock(o.closest, o.now), alerts };
}
