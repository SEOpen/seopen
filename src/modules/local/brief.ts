/** The top of the Local SEO pages, from stored check counts. Pure, so it's tested and costs nothing. */
import type { FigureData } from "@/components/ui/figure";
import { changeDelta, countOf, countWord } from "@/lib/brief";
import { formatNumber, formatShortDate } from "@/lib/format";
import { addStats, avgRank, foundShare, rankChange, type KeywordStats } from "./metrics";

/** One keyword in the check on screen, and in the check it's compared with. */
export interface KeywordReading {
  cur: KeywordStats;
  prev: KeywordStats | null | undefined;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Which way a keyword went: its average rank first, then whether the listing appeared at all, then at how
 * many of the points that answered. Null when either check has no answers to compare.
 */
export function keywordMove({ cur, prev }: KeywordReading): "up" | "down" | "same" | null {
  if (!prev?.answered || !cur.answered) return null;
  const change = rankChange(cur, prev);
  if (change) return change < 0 ? "up" : "down";
  const was = avgRank(prev);
  const now = avgRank(cur);
  if (was == null && now != null) return "up";
  if (was != null && now == null) return "down";
  const found = (foundShare(cur) ?? 0) - (foundShare(prev) ?? 0);
  return found > 0 ? "up" : found < 0 ? "down" : "same";
}

/** What moved in a check against the one before. "Nothing moved" and a first check are real answers. */
export function localSentence({
  rows,
  at,
  previousAt,
  timeZone,
  latest: latestOnScreen = true,
  newerFailed = false,
}: {
  rows: KeywordReading[];
  at: Date | string;
  previousAt: Date | string | null;
  timeZone: string;
  /** False when an older check is on screen, so the sentence says which one. */
  latest?: boolean;
  /** A newer check failed, so the one on screen isn't the latest word. */
  newerFailed?: boolean;
}): string {
  const latest = latestOnScreen && !newerFailed;
  const day = formatShortDate(at, timeZone);
  if (!previousAt) return newerFailed ? `Only the ${day} check has results so far.` : `First check on ${day}. Changes show after the next one.`;
  const before = formatShortDate(previousAt, timeZone);
  const since = before === day ? "the check before" : before;
  const moves = rows.map(keywordMove);
  if (!moves.some(Boolean)) return `No results to compare with ${since} yet.`;
  const up = moves.filter((m) => m === "up").length;
  const down = moves.filter((m) => m === "down").length;
  if (!up && !down) return latest ? `Nothing moved since ${since}.` : `Nothing moved between ${since} and ${day}.`;
  const what = up && down ? `${countOf(up, "keyword")} moved up and ${countWord(down)} moved down` : up ? `${countOf(up, "keyword")} moved up` : `${countOf(down, "keyword")} moved down`;
  const clause = `${what} on Google Maps, compared with ${since}.`;
  return latest ? capitalize(clause) : `On ${day}, ${clause}`;
}

/** The sentence for a business with keywords and no results yet. */
export function localWaiting({ running, scheduled, noResults }: { running: boolean; scheduled: boolean; /** Why there are none, when a check was tried. */ noResults?: string | null }): string {
  if (running) return "The first check is running. Results usually land within a few minutes.";
  if (noResults) return noResults;
  if (scheduled) return "Waiting for the first check. The weekly check runs it, or Check now runs one sooner.";
  return "Not checked yet. Check now runs the first one.";
}

/** The line under a business's name: its grid, how often it's checked, and when it last was. */
export function businessLine({ gridSize, radiusMiles, everyDays, lastChecked, failed = false }: { gridSize: number; radiusMiles: number; everyDays: number | null; lastChecked: string | null; /** The newest check failed. */ failed?: boolean }): string {
  const grid = `${gridSize}×${gridSize} grid across ${radiusMiles} ${radiusMiles === 1 ? "mile" : "miles"}`;
  const schedule = everyDays == null ? "checked when you press Check now" : `checked every ${everyDays} days`;
  if (failed) return `${grid}, ${schedule}, ${lastChecked ? `last good check ${lastChecked}` : "no successful check yet"}.`;
  return `${grid}, ${schedule}, ${lastChecked ? `last on ${lastChecked}` : "not checked yet"}.`;
}

/** The sentence for the list of businesses when none has results yet. */
export const LIST_WAITING = "No check has run yet. Open a business to add its keywords and run the first one.";

/** The keywords both checks answered, summed, so a keyword added since can't read as a change. */
export function comparedStats(rows: KeywordReading[]): { cur: KeywordStats; prev: KeywordStats } | null {
  const both = rows.filter((r) => keywordMove(r) != null);
  if (!both.length) return null;
  return { cur: addStats(both.map((r) => r.cur)), prev: addStats(both.map((r) => r.prev as KeywordStats)) };
}

/** A change in average rank, which always reads as better or worse. */
export function rankDelta(change: number | null) {
  return change == null ? null : changeDelta(change, "decimal", "down", true);
}

/** Points gained or lost. A grid that changed size between checks can't compare counts, so it compares shares. */
function pointsDelta(now: number, nowOf: number, before: number, beforeOf: number) {
  return nowOf === beforeOf ? changeDelta(now - before, "number", "up") : changeDelta(now / nowOf - before / beforeOf, "points", "up");
}

/** The numbers the page leads on, across the keywords given. Nothing answered yet means no figures to show. */
export function localFigures({ rows, previousAt, timeZone }: { rows: KeywordReading[]; previousAt: Date | string | null; timeZone: string }): FigureData[] {
  const total = addStats(rows.map((r) => r.cur));
  if (!total.answered) return [];
  const base = previousAt ? comparedStats(rows) : null;
  const since = base && previousAt ? `vs ${formatShortDate(previousAt, timeZone)}` : "nothing earlier to compare";
  const avg = avgRank(total);
  const failed = total.failed ? `, ${formatNumber(total.failed)} failed` : "";
  return [
    avg == null
      ? { id: "rank", state: "empty", label: "Avg. map rank", text: "Not in the top 20 at any point." }
      : {
          id: "rank",
          state: "value",
          label: "Avg. map rank",
          value: avg.toFixed(1),
          delta: base ? rankDelta(rankChange(base.cur, base.prev)) : null,
          // The gauge sets its dot against the ghost, so it only draws one when both read the same keywords.
          position: { value: avg, previous: base && avgRank(base.cur) === avg ? avgRank(base.prev) : null },
          caption: `average where you appear, ${since}`,
        },
    {
      id: "top3",
      state: "value",
      label: "Top 3",
      value: `${formatNumber(total.top3)} of ${formatNumber(total.answered)}`,
      delta: base ? pointsDelta(base.cur.top3, base.cur.answered, base.prev.top3, base.prev.answered) : null,
      caption: `points ranking 1 to 3, ${since}`,
    },
    {
      id: "found",
      state: "value",
      label: "Points found",
      value: `${formatNumber(total.found)} of ${formatNumber(total.answered)}`,
      delta: base ? pointsDelta(base.cur.found, base.cur.answered, base.prev.found, base.prev.answered) : null,
      caption: `points listing you in the top 20${failed}, ${since}`,
    },
  ];
}
