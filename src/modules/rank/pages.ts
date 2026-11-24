// Ranking URLs and cannibalization, from stored results.
import { averagePosition, ctr } from "./metrics";
import { firstAndLast, type RankKeyword, type ResultRow } from "./queries";
import { carryDeepPositions } from "./recheck";

export interface PageRow extends Record<string, unknown> {
  url: string;
  keywords: number;
  keywordsDelta: number | null;
  avgPosition: number | null;
  traffic: number;
  volume: number;
  topKeyword: string;
}

/** Our ranking URLs on the last check, with the keyword count change since the first check in the window. `from` is that window's first date when `rows` come from `loadResultsToCarry`. */
export function buildPages(keywords: RankKeyword[], rows: ResultRow[], from?: string): PageRow[] {
  const byId = new Map(keywords.filter((k) => k.active).map((k) => [k.id, k]));
  const ends = firstAndLast(carryDeepPositions(rows.filter((r) => byId.has(r.keywordId)), from));
  const startCounts = new Map<string, number>();
  const pages = new Map<string, { positions: number[]; traffic: number; volume: number; top: { kw: string; p: number } }>();
  let sameDate = true;

  for (const [id, { first, last }] of ends) {
    const k = byId.get(id)!;
    if (first !== last) sameDate = false;
    if (first.url) startCounts.set(first.url, (startCounts.get(first.url) ?? 0) + 1);
    if (!last.url || last.position == null) continue;
    const p = pages.get(last.url) ?? { positions: [], traffic: 0, volume: 0, top: { kw: k.keyword, p: last.position } };
    p.positions.push(last.position);
    p.traffic += ctr(last.position) * (k.searchVolume ?? 0);
    p.volume += k.searchVolume ?? 0;
    if (last.position < p.top.p) p.top = { kw: k.keyword, p: last.position };
    pages.set(last.url, p);
  }

  return [...pages.entries()]
    .map(([url, p]) => ({
      url,
      keywords: p.positions.length,
      keywordsDelta: sameDate ? null : p.positions.length - (startCounts.get(url) ?? 0),
      avgPosition: averagePosition(p.positions),
      traffic: Math.round(p.traffic * 10) / 10,
      volume: p.volume,
      topKeyword: p.top.kw,
    }))
    .sort((a, b) => b.traffic - a.traffic || b.keywords - a.keywords);
}

/** Pages that ranked on the first check in the window and rank for nothing on the last, so the list above can't show them. */
export function droppedPages(keywords: RankKeyword[], rows: ResultRow[], from?: string): { url: string; keywords: number }[] {
  const active = new Set(keywords.filter((k) => k.active).map((k) => k.id));
  const ends = firstAndLast(carryDeepPositions(rows.filter((r) => active.has(r.keywordId)), from));
  const before = new Map<string, number>();
  const now = new Set<string>();
  for (const { first, last } of ends.values()) {
    if (first.url && first.position != null) before.set(first.url, (before.get(first.url) ?? 0) + 1);
    if (last.url && last.position != null) now.add(last.url);
  }
  return [...before.entries()].filter(([url]) => !now.has(url)).map(([url, n]) => ({ url, keywords: n }));
}

export interface CannibalRow {
  keywordId: number;
  keyword: string;
  volume: number | null;
  urls: string[];
  /** Checks where the ranking URL differed from the previous check. */
  flips: number;
  /** Checks where two or more of our URLs ranked at once. */
  multiDays: number;
  checks: number;
  bestPosition: number | null;
  latestUrl: string | null;
}

/**
 * Keywords where several of our URLs compete: two or more ranked on the same
 * SERP, or the ranking URL swapped between checks. `rows` must be in date order.
 */
export function findCannibalization(keywords: RankKeyword[], rows: ResultRow[]): CannibalRow[] {
  const byId = new Map(keywords.filter((k) => k.active).map((k) => [k.id, k]));
  const per = new Map<number, ResultRow[]>();
  for (const r of rows) {
    if (!byId.has(r.keywordId)) continue;
    const list = per.get(r.keywordId) ?? [];
    list.push(r);
    per.set(r.keywordId, list);
  }

  const out: CannibalRow[] = [];
  for (const [id, list] of per) {
    const urls = new Set<string>();
    let flips = 0;
    let multiDays = 0;
    let best: number | null = null;
    let prev: string | null = null;
    for (const r of list) {
      for (const o of r.ownUrls) urls.add(o.u);
      if (r.url) urls.add(r.url);
      if (r.ownUrls.length >= 2) multiDays++;
      if (r.url && prev && r.url !== prev) flips++;
      if (r.url) prev = r.url;
      if (r.position != null && (best == null || r.position < best)) best = r.position;
    }
    if (urls.size < 2 || (!flips && !multiDays)) continue;
    const k = byId.get(id)!;
    out.push({
      keywordId: id,
      keyword: k.keyword,
      volume: k.searchVolume,
      urls: [...urls].sort(),
      flips,
      multiDays,
      checks: list.length,
      bestPosition: best,
      latestUrl: list[list.length - 1].url,
    });
  }
  return out.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0) || b.flips + b.multiDays - (a.flips + a.multiDays));
}

/** Per URL: how many cannibalized keywords it is involved in. */
export function cannibalPages(rows: CannibalRow[]): { url: string; keywords: number; volume: number }[] {
  const m = new Map<string, { keywords: number; volume: number }>();
  for (const r of rows) {
    for (const u of r.urls) {
      const e = m.get(u) ?? { keywords: 0, volume: 0 };
      e.keywords++;
      e.volume += r.volume ?? 0;
      m.set(u, e);
    }
  }
  return [...m.entries()].map(([url, e]) => ({ url, ...e })).sort((a, b) => b.keywords - a.keywords || b.volume - a.volume);
}
