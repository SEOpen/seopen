// Turns stored rows into the overview: per-date summaries, start/end comparison and filtered table rows.
import type { RankingRow } from "./components/rankings-table";
import { bucketOf, classifyChange, ctr, positionDelta, summarizeByDate, type Bucket, type Change, type Summary } from "./metrics";
import { firstAndLast, type RankKeyword, type ResultRow } from "./queries";
import { carryDeepPositions } from "./recheck";

export interface OverviewFilters {
  bucket?: Bucket;
  change?: Change | "moved";
  tag?: string;
  feature?: string;
  /** "cited" | "present" | "absent" */
  aio?: string;
  url?: string;
}

export function parseFilters(sp: Record<string, string | string[] | undefined>): OverviewFilters {
  const one = (k: string) => {
    const v = sp[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s ? s : undefined;
  };
  return {
    bucket: one("bucket") as Bucket | undefined,
    change: one("change") as OverviewFilters["change"],
    tag: one("tag"),
    feature: one("feature"),
    aio: one("aio"),
    url: one("url"),
  };
}

export type DatePoint = Summary & { date: string };

/** AI Overviews as of each keyword's latest check that loaded their sources. */
export interface AiOverviewSummary {
  date: string;
  cited: number;
  present: number;
}

export interface Overview {
  series: DatePoint[];
  start: DatePoint | null;
  end: DatePoint | null;
  rows: RankingRow[];
  totalRows: number;
  tags: string[];
  features: string[];
  improved: number;
  declined: number;
  /** Null when no check in the window loaded AI Overview sources. */
  ai: AiOverviewSummary | null;
}

/**
 * `searchConsole` holds averages by lowercase keyword (search-console.ts), noted beside a keyword no look found.
 * `from` is the window's first date when `results` come from `loadResultsToCarry`.
 */
export function buildOverview(keywords: RankKeyword[], results: ResultRow[], filters: OverviewFilters, searchConsole?: Map<string, number>, from?: string): Overview {
  const active = keywords.filter((k) => k.active);
  const byId = new Map(active.map((k) => [k.id, k]));
  const rowsIn = carryDeepPositions(results.filter((r) => byId.has(r.keywordId)), from);
  const ends = firstAndLast(rowsIn);
  // Only the checks that load AI Overview sources can say whether we're cited; the daily ones can't.
  const latestAi = new Map(rowsIn.filter((r) => r.aiOverviewLoaded).map((r) => [r.keywordId, r]));

  const allRows: RankingRow[] = active.map((k) => {
    const fl = ends.get(k.id);
    const first = fl?.first ?? null;
    const last = fl?.last ?? null;
    const position = last?.position ?? null;
    // A last check that couldn't be confirmed repeats an old result, so it says nothing about a move, as on the Overview's table.
    const carried = !!last?.notChecked;
    const start = first && first !== last ? first.position : (last?.position ?? null);
    const ai = latestAi.get(k.id);
    const average = position == null && last ? searchConsole?.get(k.keyword.toLowerCase()) : undefined;
    return {
      id: k.id,
      keyword: k.keyword,
      tags: k.tags,
      device: k.device,
      position,
      start,
      delta: carried ? null : positionDelta(start, position),
      // "none" when no check in the window found it, however many checks there were, as classifyChange says for two.
      change: !carried && first && first !== last ? classifyChange(first.position, position) : position != null ? "unchanged" : "none",
      url: last?.url ?? null,
      volume: k.searchVolume,
      traffic: ctr(position) * (k.searchVolume ?? 0),
      features: last?.serpFeatures ?? [],
      owned: last?.ownedFeatures ?? [],
      aio: ai ? (ai.aiOverviewCited ? "cited" : ai.aiOverview ? "present" : "none") : null,
      aioDate: ai?.date ?? null,
      checked: !!last,
      notChecked: carried,
      deeperCheckDate: last?.deeperCheckDate ?? null,
      depth: last?.depth ?? null,
      searchConsole: average != null && last && average <= last.depth ? average : null,
    };
  });

  const keep = new Set(allRows.filter((r) => matches(r, filters)).map((r) => r.id));
  const rows = allRows.filter((r) => keep.has(r.id));

  // Summaries follow the filter, so "tag: core" shows that segment's visibility.
  const dated = rowsIn
    .filter((r) => keep.has(r.keywordId))
    .map((r) => ({ ...r, volume: byId.get(r.keywordId)!.searchVolume }));
  const series: DatePoint[] = summarizeByDate(dated);
  const aiRows = [...latestAi.values()].filter((r) => keep.has(r.keywordId));

  return {
    series,
    start: series[0] ?? null,
    end: series[series.length - 1] ?? null,
    rows,
    totalRows: allRows.length,
    tags: [...new Set(active.flatMap((k) => k.tags))].sort(),
    features: [...new Set(allRows.flatMap((r) => r.features))].sort(),
    improved: rows.filter((r) => r.change === "improved" || r.change === "new").length,
    declined: rows.filter((r) => r.change === "declined" || r.change === "lost").length,
    ai: aiRows.length
      ? {
          date: aiRows.reduce((d, r) => (r.date > d ? r.date : d), aiRows[0].date),
          cited: aiRows.filter((r) => r.aiOverviewCited).length,
          present: aiRows.filter((r) => r.aiOverview).length,
        }
      : null,
  };
}

function matches(r: RankingRow, f: OverviewFilters): boolean {
  if (f.bucket && bucketOf(r.position) !== f.bucket) return false;
  if (f.change === "moved" && !["improved", "declined", "new", "lost"].includes(r.change)) return false;
  if (f.change && f.change !== "moved" && r.change !== f.change) return false;
  if (f.tag && !r.tags.includes(f.tag)) return false;
  if (f.feature === "owned-any" && !r.owned.length) return false;
  if (f.feature && f.feature !== "owned-any" && !r.features.includes(f.feature)) return false;
  if (f.aio === "cited" && r.aio !== "cited") return false;
  if (f.aio === "present" && r.aio !== "present" && r.aio !== "cited") return false;
  if (f.aio === "absent" && (r.aio === "present" || r.aio === "cited")) return false;
  if (f.url && r.url !== f.url) return false;
  return true;
}

/**
 * What the top of the page can say. A filter empties `end`, so "no checks yet" has to come from the
 * unfiltered overview: otherwise a filter that matches nothing reads as though nothing was ever checked.
 */
export function briefingKind(filtered: Pick<Overview, "rows" | "end">, unfiltered: Pick<Overview, "end">): "no-checks" | "results" | "no-match" | "not-checked" {
  if (!unfiltered.end) return "no-checks";
  if (filtered.end) return "results";
  return filtered.rows.length ? "not-checked" : "no-match";
}

/** Change between the first and last summary, or null when there's only one date. */
export function summaryDelta(o: Overview, key: keyof Summary): number | null {
  if (!o.start || !o.end || o.start.date === o.end.date) return null;
  const a = o.start[key];
  const b = o.end[key];
  return a == null || b == null ? null : Number(b) - Number(a);
}
