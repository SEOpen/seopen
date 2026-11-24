// Competitor views from stored SERPs: no extra API calls, because every check keeps each domain's best hit.
import { bareHost } from "./parse";
import { ctr, CTR_TOP20_TOTAL, summarize, type RankRow, type Summary } from "./metrics";
import { domainPosition, type DomainRow, type RankKeyword } from "./queries";
import { carryDeepPositions } from "./recheck";

export interface DomainSummary extends Summary {
  domain: string;
  isProject: boolean;
}

export interface CompetitorView {
  domains: string[];
  /** One row per date with a column per domain, for each metric. */
  series: { date: string; [domain: string]: number | string | null }[];
  seriesSov: { date: string; [domain: string]: number | string | null }[];
  seriesAvg: { date: string; [domain: string]: number | string | null }[];
  start: Map<string, Summary>;
  end: Map<string, Summary>;
  /** Other domains seen on the latest SERPs, best share of voice first. */
  discovered: { domain: string; keywords: number; avgPosition: number; visibility: number; shareOfVoice: number }[];
  /** Keywords in the newest check whose results no look confirmed, so every domain's position on them is old. */
  endNotConfirmed: number;
}

/**
 * `rows` oldest first. With `from`, rows before it only carry deep positions in (see
 * `loadDomainResultsToCarry`) and aren't counted, as on Rankings.
 */
export function buildCompetitorView(
  projectDomain: string,
  competitors: string[],
  keywords: RankKeyword[],
  rows: DomainRow[],
  from?: string,
): CompetitorView {
  const volume = new Map(keywords.filter((k) => k.active).map((k) => [k.id, k.searchVolume]));
  const domains = [projectDomain, ...competitors];
  // Each domain's position on each row, a #50 from the weekly sweep carried through the next days'
  // shallower checks, as Rankings carries yours. Without it a rival's sweep-only position would drop
  // out the day after the sweep and read as a loss.
  const active = rows.filter((r) => volume.has(r.keywordId));
  const positions = new Map<string, Map<DomainRow, number | null>>();
  for (const d of domains) {
    const own = active.map((row) => ({
      row,
      keywordId: row.keywordId,
      date: row.date,
      depth: row.depth,
      notChecked: row.notChecked,
      position: d === projectDomain ? row.position : (domainPosition(row.domains, d)?.p ?? null),
    }));
    positions.set(d, new Map(carryDeepPositions(own).map((c) => [c.row, c.position])));
  }
  const counted = from ? rows.filter((r) => r.date >= from) : rows;
  const dates = [...new Set(counted.map((r) => r.date))].sort();
  const byDate = new Map<string, DomainRow[]>();
  for (const r of counted) {
    if (!volume.has(r.keywordId)) continue;
    const list = byDate.get(r.date) ?? [];
    list.push(r);
    byDate.set(r.date, list);
  }

  const perDate = new Map<string, Map<string, Summary>>();
  for (const date of dates) {
    const list = byDate.get(date) ?? [];
    const m = new Map<string, Summary>();
    for (const d of domains) {
      const rr: RankRow[] = list.map((r) => ({
        position: positions.get(d)?.get(r) ?? null,
        volume: volume.get(r.keywordId) ?? null,
        // A row no look confirmed repeats the last results page, so every domain's position on it is old.
        notChecked: r.notChecked,
      }));
      m.set(d, summarize(rr));
    }
    perDate.set(date, m);
  }

  const pick = (key: keyof Summary) =>
    dates.map((date) => {
      const row: { date: string; [k: string]: number | string | null } = { date };
      for (const d of domains) row[d] = (perDate.get(date)?.get(d)?.[key] as number | null) ?? null;
      return row;
    });

  const first = dates[0];
  const last = dates[dates.length - 1];
  const known = new Set(domains.map((d) => bareHost(d)!));
  const discovered = last ? discover(byDate.get(last) ?? [], volume, known) : [];

  return {
    domains,
    series: pick("visibility"),
    seriesSov: pick("shareOfVoice"),
    seriesAvg: pick("avgPosition"),
    start: perDate.get(first) ?? new Map(),
    end: perDate.get(last) ?? new Map(),
    discovered,
    endNotConfirmed: last ? (byDate.get(last) ?? []).filter((r) => r.notChecked).length : 0,
  };
}

/** Every other host on these SERPs, scored the same way as tracked domains. */
function discover(rows: DomainRow[], volume: Map<number, number | null>, exclude: Set<string>) {
  const n = rows.length;
  if (!n) return [];
  const useVolume = rows.some((r) => (volume.get(r.keywordId) ?? 0) > 0);
  const totalWeight = rows.reduce((s, r) => s + (useVolume ? (volume.get(r.keywordId) ?? 0) : 1), 0);
  const agg = new Map<string, { keywords: number; posSum: number; ctrSum: number; weighted: number }>();
  for (const r of rows) {
    const w = useVolume ? (volume.get(r.keywordId) ?? 0) : 1;
    for (const [host, hit] of Object.entries(r.domains)) {
      if ([...exclude].some((d) => host === d || host.endsWith(`.${d}`))) continue;
      const a = agg.get(host) ?? { keywords: 0, posSum: 0, ctrSum: 0, weighted: 0 };
      a.keywords++;
      a.posSum += hit.p;
      a.ctrSum += ctr(hit.p);
      a.weighted += w * ctr(hit.p);
      agg.set(host, a);
    }
  }
  return [...agg.entries()]
    .map(([domain, a]) => ({
      domain,
      keywords: a.keywords,
      avgPosition: a.posSum / a.keywords,
      visibility: a.ctrSum / (n * ctr(1)),
      shareOfVoice: totalWeight ? a.weighted / (totalWeight * CTR_TOP20_TOTAL) : 0,
    }))
    .sort((a, b) => b.shareOfVoice - a.shareOfVoice || b.keywords - a.keywords)
    .slice(0, 40);
}
