// When one look at a SERP can't be believed. Pure, so the rules are unit tested (recheck.test.ts);
// tracker.ts does the posting and storing.
import { MAX_LOOKS } from "./metrics";

/** A look this many positions below the recent best gets checked again. */
export const DROP_POSITIONS = 10;
/** "Recent": the window for the best position, and for "it ranked before". */
export const RECENT_DAYS = 14;
/** After this many days in a row with no look finding it, a keyword is recorded as not ranking. */
export const MAX_NOT_CHECKED_DAYS = 3;
/** Days in a row a keyword with no position gets extra looks, so a real miss doesn't cost extra forever. */
export const MAX_MISS_DAYS = 3;

export interface HistoryRow {
  date: string;
  position: number | null;
  notChecked: boolean;
}

export interface Baseline {
  /** The keyword's latest recorded position; null when that was "not ranking". */
  last: number | null;
  /** Best position in the recent window; the latest row always counts, however old. */
  best: number | null;
  /** Rows in a row, newest first, that only repeat an earlier result. */
  notCheckedDays: number;
  /** Search Console's recent average position, while it still earns a keyword extra looks. */
  searchConsole?: number | null;
  /** It has only just started missing from this place, so one look can't say it isn't there. */
  earlyMiss?: boolean;
}

export function daysBefore(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** `rows` newest first, none later than `date`. */
export function baselineFrom(rows: HistoryRow[], date: string): Baseline {
  const since = daysBefore(date, RECENT_DAYS);
  const recent = rows.filter((r, i) => i === 0 || r.date >= since).flatMap((r) => (r.position == null ? [] : [r.position]));
  let notCheckedDays = 0;
  while (notCheckedDays < rows.length && rows[notCheckedDays].notChecked) notCheckedDays++;
  return { last: rows[0]?.position ?? null, best: recent.length ? Math.min(...recent) : null, notCheckedDays };
}

/**
 * Earlier days in a row with no position from this place. `rows` newest first; rows from another
 * place, or from before places were recorded, don't count.
 */
export function missDays(rows: (HistoryRow & { locationCode: number | null })[], date: string, locationCode: number): number {
  let misses = 0;
  for (const r of rows) {
    if (r.date >= date) continue;
    if (r.locationCode !== locationCode || r.position != null) break;
    misses++;
  }
  return misses;
}

/**
 * Search Console's average position, or null once it has stopped earning extra looks: after
 * `MAX_MISS_DAYS` earlier days in a row with no position from this place. Its average covers every
 * location, so it's a reason to look again and never a position to show.
 */
export function searchConsoleHint(average: number | null, rows: (HistoryRow & { locationCode: number | null })[], date: string, locationCode: number): number | null {
  return average != null && missDays(rows, date, locationCode) < MAX_MISS_DAYS ? average : null;
}

/**
 * Whether a look needs another. Not found, when the keyword ranked recently within this check's
 * depth (a #50 from the weekly sweep is expected to be missing from a top 20), or Search Console
 * puts it within that depth, or it has no recent position or Search Console figure to go on and has
 * only just started missing here: a new keyword or place shouldn't be judged on one look. Found, when
 * it's far below the recent best, unless it had no position to fall from: that is a recovery.
 */
export function needsRecheck(position: number | null, b: Baseline, depth: number): boolean {
  if (position == null) {
    if ((b.best != null && b.best <= depth) || (b.searchConsole != null && b.searchConsole <= depth)) return true;
    return b.best == null && b.searchConsole == null && !!b.earlyMiss;
  }
  return b.best != null && b.last != null && position - b.best >= DROP_POSITIONS;
}

/** The look that found the keyword highest; on a tie, the latest. Null when none found it. */
export function bestLook<L extends { position: number | null }>(looks: L[]): L | null {
  let best: L | null = null;
  for (const l of looks) if (l.position != null && (best?.position == null || l.position <= best.position)) best = l;
  return best;
}

/** What `carryDeepPositions` needs of a stored row. */
export interface DepthRow {
  keywordId: number;
  date: string;
  position: number | null;
  url?: string | null;
  depth: number;
  notChecked?: boolean;
}

/**
 * A check only sees as deep as it looks. A #50 from the weekly sweep is out of sight for the next
 * day's top 20, and that miss says nothing about it: the row keeps the #50, and `deeperCheckDate`
 * says which check saw it. A miss at a depth that would have found the position is a real one, and
 * a position older than the recent window stops being carried. `rows` oldest first.
 *
 * With `from`, rows before that date only say what was seen and aren't returned, so a window that
 * opens on a shallow check doesn't read a steady #50 as new (`loadResultsToCarry` reads them).
 */
export function carryDeepPositions<R extends DepthRow>(rows: R[], from?: string): (R & { deeperCheckDate: string | null })[] {
  const seen = new Map<number, { position: number; url: string | null; date: string }>();
  const carried = rows.map((r) => {
    if (r.position != null) {
      // A not-checked row repeats an earlier result, so it isn't a new sighting.
      const date = r.notChecked ? (seen.get(r.keywordId)?.date ?? r.date) : r.date;
      seen.set(r.keywordId, { position: r.position, url: r.url ?? null, date });
      return { ...r, deeperCheckDate: null };
    }
    const s = seen.get(r.keywordId);
    if (!s || s.position <= r.depth || s.date < daysBefore(r.date, RECENT_DAYS)) {
      seen.delete(r.keywordId);
      return { ...r, deeperCheckDate: null };
    }
    return { ...r, position: s.position, url: s.url, deeperCheckDate: s.date };
  });
  return from ? carried.filter((r) => r.date >= from) : carried;
}

export type LookStep<L> =
  /** Post another look. */
  | { kind: "recheck" }
  /** Record this look. */
  | { kind: "store"; look: L }
  /** Every look missed a keyword that was ranking: keep its last position and say it wasn't confirmed. */
  | { kind: "not_checked" };

/**
 * What to do after the looks so far, oldest first (at least one). `canRecheck` is false when another
 * look can't be had: the spending limit refused it, or posting or fetching it failed.
 */
export function nextStep<L extends { position: number | null }>(looks: L[], b: Baseline, opts: { depth: number; canRecheck: boolean }): LookStep<L> {
  const best = bestLook(looks);
  const latest = looks[looks.length - 1];
  if (!needsRecheck(best?.position ?? null, b, opts.depth)) return { kind: "store", look: best ?? latest };
  if (opts.canRecheck && looks.length < MAX_LOOKS) return { kind: "recheck" };
  if (best) return { kind: "store", look: best };
  // A last position beyond this check's depth (a #50 from the sweep): the miss says nothing about it.
  if (b.last != null && b.last <= opts.depth && b.notCheckedDays < MAX_NOT_CHECKED_DAYS) return { kind: "not_checked" };
  return { kind: "store", look: latest };
}
