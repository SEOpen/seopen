// Metrics over grid points. Pure, so it is unit tested and safe in client components.
import type { LocalListing } from "@/db/schema/local";
import { isSameListing, type ListingIds } from "./parse";

export type PointStatus = "pending" | "done" | "failed";

/** Counts for one keyword in one check. Failed points never count as "not found". */
export interface KeywordStats {
  /** Every point of the grid. */
  total: number;
  /** Points Maps answered with listings: found plus not found. */
  answered: number;
  failed: number;
  /** Answered points where our listing is in the top 20. */
  found: number;
  top3: number;
  /** Sum of our ranks at the found points. */
  rankSum: number;
}

export const EMPTY_STATS: KeywordStats = { total: 0, answered: 0, failed: 0, found: 0, top3: 0, rankSum: 0 };

export function statsFromPoints(points: { status: PointStatus; rank: number | null }[]): KeywordStats {
  const s = { ...EMPTY_STATS };
  for (const p of points) {
    s.total++;
    if (p.status === "failed") s.failed++;
    if (p.status !== "done") continue;
    s.answered++;
    if (p.rank != null) {
      s.found++;
      s.rankSum += p.rank;
      if (p.rank <= 3) s.top3++;
    }
  }
  return s;
}

/** Average rank over the points where we were found; null when found nowhere. */
export function avgRank(s: KeywordStats): number | null {
  return s.found ? s.rankSum / s.found : null;
}

/** Share of answered points where we rank 1–3; null when no point answered. */
export function top3Share(s: KeywordStats): number | null {
  return s.answered ? s.top3 / s.answered : null;
}

/** Share of answered points where we were found; null when no point answered. */
export function foundShare(s: KeywordStats): number | null {
  return s.answered ? s.found / s.answered : null;
}

/** "12/25", with failed points said separately so they never read as "not found". */
export function foundLabel(s: KeywordStats): string {
  const base = `${s.found}/${s.answered}`;
  return s.failed ? `${base} · ${s.failed} failed` : base;
}

/** Change in average rank since the previous check (negative is better); null without both. */
export function rankChange(cur: KeywordStats, prev: KeywordStats | null | undefined): number | null {
  const a = avgRank(cur);
  const b = prev ? avgRank(prev) : null;
  return a == null || b == null ? null : Math.round((a - b) * 10) / 10;
}

/** Sums stats over several keywords, for a business or project total. */
export function addStats(all: KeywordStats[]): KeywordStats {
  return all.reduce(
    (t, s) => ({
      total: t.total + s.total,
      answered: t.answered + s.answered,
      failed: t.failed + s.failed,
      found: t.found + s.found,
      top3: t.top3 + s.top3,
      rankSum: t.rankSum + s.rankSum,
    }),
    { ...EMPTY_STATS },
  );
}

/** The legend bucket of a point: 1–3, 4–10, 11–20, not found, failed, or still waiting. */
export type Bucket = "top3" | "top10" | "top20" | "none" | "failed" | "pending";

export function bucketOf(p: { status: PointStatus; rank: number | null }): Bucket {
  if (p.status === "pending") return "pending";
  if (p.status === "failed") return "failed";
  if (p.rank == null) return "none";
  if (p.rank <= 3) return "top3";
  if (p.rank <= 10) return "top10";
  return "top20";
}

/** A business seen across the grid. */
export interface Competitor {
  key: string;
  title: string;
  category: string | null;
  rating: number | null;
  votes: number | null;
  /** Answered points where it appears in the top 20. */
  present: number;
  avgRank: number;
  /** Points that answered, the denominator of `present`. */
  answered: number;
  ours: boolean;
}

/**
 * Every business Maps listed across the grid, by points present (most first), then average rank.
 * Listings are told apart by cid, then place_id, then title.
 */
export function competitorsAcrossGrid(
  points: { status: PointStatus; items: LocalListing[] }[],
  ours: ListingIds,
  limit = 10,
): Competitor[] {
  const answered = points.filter((p) => p.status === "done");
  const by = new Map<string, Competitor & { rankSum: number }>();
  for (const p of answered) {
    const seenHere = new Set<string>();
    for (const it of p.items) {
      const key = it.cid ? `cid:${it.cid}` : it.pid ? `pid:${it.pid}` : `t:${it.t.toLowerCase()}`;
      if (seenHere.has(key)) continue;
      seenHere.add(key);
      const c = by.get(key) ?? {
        key,
        title: it.t,
        category: it.cat,
        rating: it.rating,
        votes: it.votes,
        present: 0,
        avgRank: 0,
        rankSum: 0,
        answered: answered.length,
        ours: isSameListing({ cid: it.cid, place_id: it.pid }, ours),
      };
      c.present++;
      c.rankSum += it.r;
      by.set(key, c);
    }
  }
  return [...by.values()]
    .map(({ rankSum, ...c }) => ({ ...c, avgRank: rankSum / c.present }))
    .sort((a, b) => b.present - a.present || a.avgRank - b.avgRank || a.title.localeCompare(b.title))
    .slice(0, limit);
}

/**
 * Whether two checks read the same number of points, so a share's change can be said as a count of
 * them, as the Local SEO page says it; a grid that changed size compares shares instead.
 */
export function sameGrid<T extends { answered: number }>(cur: T, prev: T | null | undefined): prev is T {
  return !!prev && prev.answered === cur.answered;
}
