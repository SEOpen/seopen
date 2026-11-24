import "server-only";
import type { ChangeDelta } from "@/components/ui/what-changed";
import type { Project } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { gscByQuery, gscDataRange, gscSeries, topPageByQuery } from "@/modules/google/data";
import { addDays, resolvePeriods } from "@/modules/google/windowing";
import { firstAndLast, loadResultsToCarry, loadTracker, resolveWindow } from "@/modules/rank/queries";
import { carryDeepPositions } from "@/modules/rank/recheck";
import { LOAD_TIMEOUT_MS, withTimeout } from "./dashboard-load";

/** Twice the longest range the chart offers, so 90 days can sit over the 90 before. */
const HISTORY_DAYS = 180;
const KEYWORD_ROWS = 8;
const QUERY_DAYS = 28;
/** Tracked keywords are joined to this many top queries for their clicks and CTR. */
const QUERY_LOOKUP = 1000;

export interface ClicksHistory {
  /** Every day in stored history, oldest first. A day with no row had no impressions, so it counts as zero. */
  days: { date: string; clicks: number }[];
}

/** Daily clicks across stored Search Console history, for the chart. Database reads only. */
export async function loadClicksHistory(project: Project): Promise<ClicksHistory | null> {
  if (!project.gscProperty) return null;
  const scope = projectScope(project);
  const range = await gscDataRange(scope);
  if (!range) return null;
  const earliest = addDays(range.last, -(HISTORY_DAYS - 1));
  const start = range.first > earliest ? range.first : earliest;
  const rows = await gscSeries(scope, { start, end: range.last });
  const byDate = new Map(rows.map((r) => [r.date, r.clicks]));
  const days: ClicksHistory["days"] = [];
  for (let date = start; date <= range.last; date = addDays(date, 1)) days.push({ date, clicks: byDate.get(date) ?? 0 });
  return { days };
}

export interface PanelKeyword {
  key: string;
  keyword: string;
  href: string;
  /** Null: not ranking, or not checked yet. `status` says which. */
  position: number | null;
  previous: number | null;
  status: string | null;
  /** The position is the last one known: no look confirmed it at the latest check, which Rankings marks too. */
  notConfirmed?: boolean;
  delta: ChangeDelta | null;
  clicks: number | null;
  ctr: number | null;
  /** The page that ranks, as a path. */
  url: string | null;
}

export interface PanelKeywords {
  source: "rank" | "gsc";
  title: string;
  href: string;
  /** What the change column compares. */
  window: string;
  total: number;
  rows: PanelKeyword[];
}

function pathOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const { pathname, search } = new URL(url);
    return `${pathname}${search}`;
  } catch {
    return url;
  }
}

/** Places moved, positive when better. */
function placeDelta(from: number | null, to: number | null): ChangeDelta | null {
  if (from == null && to != null) return { text: "new", tone: "good", up: true };
  if (from != null && to == null) return { text: "lost", tone: "bad", up: false };
  if (from == null || to == null) return null;
  const moved = Math.round((from - to) * 10) / 10;
  if (moved === 0) return { text: "0", tone: "muted", up: null };
  return { text: String(Math.abs(moved)), tone: moved > 0 ? "good" : "bad", up: moved > 0 };
}

/**
 * A tracked keyword's move across the window, from its first and last checks. One check has nothing
 * earlier to compare, so it has no change at all: not a 0, and not "new". A last check that couldn't be
 * confirmed repeats an old result, so it says nothing either. A keyword that held its place has no move
 * to show, the "–" the Rankings table draws, rather than a 0.
 */
export function keywordMove(m: { first: { date: string; position: number | null }; last: { date: string; position: number | null; notChecked: boolean } } | undefined): { previous: number | null; delta: ChangeDelta | null } {
  if (!m || m.first.date === m.last.date) return { previous: null, delta: null };
  const delta = m.last.notChecked ? null : placeDelta(m.first.position, m.last.position);
  return { previous: m.first.position, delta: delta?.up === null ? null : delta };
}

/**
 * The keywords table: tracked keywords, best position first, with Search Console's clicks and CTR
 * where a query matches. A project that tracks nothing shows its top Search Console queries.
 */
export async function loadPanelKeywords(project: Project): Promise<PanelKeywords | null> {
  const scope = projectScope(project);
  const [tracker, range] = await Promise.all([loadTracker(scope), project.gscProperty ? gscDataRange(scope) : null]);
  const periods = range ? resolvePeriods(range.last, QUERY_DAYS, "prev") : null;

  // Paused keywords have no results to show (loadResults reads active ones), so they'd all read "Not checked".
  const tracked = tracker.keywords.filter((k) => k.active);
  if (tracked.length) {
    const win = resolveWindow(tracker.dates, 7);
    const [results, queries] = await Promise.all([
      win ? loadResultsToCarry(scope, win.start, win.end, tracker.place) : [],
      periods ? gscByQuery(scope, periods.current, null, { limit: QUERY_LOOKUP }) : [],
    ]);
    // Through the same reading as the Rankings table: a #50 from the weekly check isn't lost the next day.
    const moves = firstAndLast(carryDeepPositions(results, win?.start));
    const byQuery = new Map(queries.map((q) => [q.key.toLowerCase(), q]));
    const rows = tracked
      .map((k): PanelKeyword => {
        const m = moves.get(k.id);
        const q = byQuery.get(k.keyword.toLowerCase());
        const position = m?.last.position ?? null;
        return {
          key: String(k.id),
          keyword: k.keyword,
          href: `/rank/${k.id}`,
          position,
          ...keywordMove(m),
          status: position != null ? null : !m ? "Not checked" : m.last.notChecked ? "Not confirmed" : "Not found",
          notConfirmed: position != null && !!m?.last.notChecked,
          clicks: q?.clicks ?? null,
          ctr: q?.ctr ?? null,
          url: pathOf(m?.last.url),
        };
      })
      .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || a.keyword.localeCompare(b.keyword));
    return { source: "rank", title: "Keywords", href: "/rank", window: "7d", total: rows.length, rows: rows.slice(0, KEYWORD_ROWS) };
  }

  if (!periods) return null;
  const queries = await gscByQuery(scope, periods.current, periods.previous, { limit: KEYWORD_ROWS });
  if (!queries.length) return null;
  const pages = await topPageByQuery(scope, periods.current, queries.map((q) => q.key));
  return {
    source: "gsc",
    title: "Top queries",
    href: "/gsc/queries",
    window: `${QUERY_DAYS}d`,
    total: queries.length,
    rows: queries.map((q) => ({
      key: q.key,
      keyword: q.key,
      href: `/gsc/query?q=${encodeURIComponent(q.key)}`,
      position: q.position,
      previous: q.prevPosition,
      status: null,
      delta: q.prevPosition == null ? null : placeDelta(q.prevPosition, q.position),
      clicks: q.clicks,
      ctr: q.ctr,
      url: pathOf(pages.get(q.key)),
    })),
  };
}

/** The chart's and the table's data. Each fails alone, with what it could load kept, like a module's loader. */
export async function loadPanel(project: Project) {
  const guard = <T,>(name: string, load: Promise<T>) =>
    withTimeout(load, LOAD_TIMEOUT_MS).catch((err) => {
      console.error(`[dashboard] ${name} failed to load for project ${project.id}`, err);
      return null;
    });
  const [clicks, keywords] = await Promise.all([guard("clicks history", loadClicksHistory(project)), guard("keywords", loadPanelKeywords(project))]);
  return { clicks, keywords };
}
