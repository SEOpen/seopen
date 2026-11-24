import { knownKd, toKeywordRow, type KeywordRow } from "@/modules/keywords/transform";
import type { CompetitorsResult, HistoryResult, OrganicMetrics, PagesResult, RankedKeywordItem } from "./types";

/** A hostname with at least one dot, at most 253 characters, made of valid labels (IDN letters allowed). */
export function isHostname(d: string): boolean {
  if (!d || d.length > 253 || !d.includes(".")) return false;
  return d.split(".").every((label) => /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u.test(label));
}

export interface Kpis {
  keywords: number;
  traffic: number;
  trafficValue: number;
  top3: number;
  top10: number;
}

export function kpis(m: OrganicMetrics | null | undefined): Kpis | null {
  if (!m) return null;
  const top3 = m.pos_1 + m.pos_2_3;
  return {
    keywords: m.count,
    traffic: Math.round(m.etv),
    trafficValue: Math.round((m.estimated_paid_traffic_cost ?? 0) * 100) / 100,
    top3,
    top10: top3 + m.pos_4_10,
  };
}

export interface Bucket {
  label: string;
  count: number;
}

/** Ranking keywords per position band. */
export function distribution(m: OrganicMetrics | null | undefined): Bucket[] {
  if (!m) return [];
  return [
    { label: "1–3", count: m.pos_1 + m.pos_2_3 },
    { label: "4–10", count: m.pos_4_10 },
    { label: "11–20", count: m.pos_11_20 },
    { label: "21–50", count: m.pos_21_30 + m.pos_31_40 + m.pos_41_50 },
    { label: "51–100", count: m.pos_51_60 + m.pos_61_70 + m.pos_71_80 + m.pos_81_90 + m.pos_91_100 },
  ];
}

export interface HistoryPoint {
  [key: string]: unknown;
  date: string;
  traffic: number;
  keywords: number;
  top10: number;
}

/** Monthly points, oldest first, labelled "2026-10". */
export function historySeries(items: HistoryResult["items"]): HistoryPoint[] {
  return (items ?? [])
    .filter((i) => i.metrics.organic)
    .map((i) => {
      const k = kpis(i.metrics.organic)!;
      return { date: `${i.year}-${String(i.month).padStart(2, "0")}`, traffic: k.traffic, keywords: k.keywords, top10: k.top10 };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export type RankStatus = "new" | "lost" | "improved" | "declined" | "same";

export interface RankedRow extends KeywordRow {
  /** Organic position (rank_group), the same scale as the KPI position buckets. */
  position: number | null;
  /** Absolute rank now (rank_absolute), counting every element on the results page: the scale of `previous` and `change`. */
  absolute: number | null;
  /** Previous absolute rank. The API reports only previous_rank_absolute. */
  previous: number | null;
  /** previous_rank_absolute − rank_absolute: positive means the keyword moved up. Absolute ranks count every SERP element. */
  change: number | null;
  url: string | null;
  traffic: number;
  share: number;
  status: RankStatus;
}

export function rankStatus(item: RankedKeywordItem): RankStatus {
  const rc = item.ranked_serp_element.serp_item.rank_changes;
  if (item.ranked_serp_element.is_lost) return "lost";
  if (rc?.is_new) return "new";
  if (rc?.is_up) return "improved";
  if (rc?.is_down) return "declined";
  return "same";
}

/** Organic results only. Requests ask for organic, but cached or older responses may still hold paid or other items. */
export const isOrganic = (item: RankedKeywordItem) => item.ranked_serp_element.serp_item.type === "organic";

/** Ranked keywords as table rows. Traffic share is each keyword's part of the current (non-lost) traffic. */
export function rankedRows(items: RankedKeywordItem[] | null | undefined): RankedRow[] {
  const list = (items ?? []).filter(isOrganic);
  const total = list.reduce((sum, i) => (i.ranked_serp_element.is_lost ? sum : sum + (i.ranked_serp_element.serp_item.etv ?? 0)), 0);
  return list.map((item) => {
    const el = item.ranked_serp_element;
    const status = rankStatus(item);
    const lost = status === "lost";
    const absolute = el.serp_item.rank_absolute;
    const previous = lost ? absolute : (el.serp_item.rank_changes?.previous_rank_absolute ?? null);
    const traffic = lost ? 0 : (el.serp_item.etv ?? 0);
    const row = toKeywordRow(item.keyword_data);
    return {
      ...row,
      kd: row.kd ?? knownKd(el.keyword_difficulty),
      position: lost ? null : el.serp_item.rank_group,
      absolute: lost ? null : absolute,
      previous,
      change: !lost && previous != null ? previous - absolute : null,
      url: el.serp_item.url,
      traffic,
      share: total > 0 ? traffic / total : 0,
      status,
    };
  });
}

/** Tabs on /domains/keywords. "all" is every keyword still ranking; lost ones have their own tab. */
export const RANK_VIEWS = {
  all: "Ranking",
  new: "New",
  improved: "Improved",
  declined: "Declined",
  lost: "Lost",
} as const;

export type RankView = keyof typeof RANK_VIEWS;

export function filterView(rows: RankedRow[], view: RankView): RankedRow[] {
  if (view === "all") return rows.filter((r) => r.status !== "lost");
  return rows.filter((r) => r.status === view);
}

export interface PageRow {
  [key: string]: unknown;
  url: string;
  path: string;
  keywords: number;
  traffic: number;
  share: number;
  top10: number;
  /**
   * What the page's clicks would cost as ads. Null when it has traffic but DataForSEO prices it at $0 or
   * not at all: its keywords have no CPC data, which isn't the same as clicks worth nothing.
   */
  trafficValue: number | null;
}

export function pageRows(items: PagesResult["items"]): PageRow[] {
  const list = (items ?? []).filter((p) => p.metrics.organic);
  const total = list.reduce((sum, p) => sum + p.metrics.organic!.etv, 0);
  return list.map((p) => {
    const k = kpis(p.metrics.organic)!;
    const etv = p.metrics.organic!.etv;
    // Path only, unless the page isn't on https://<domain> (http or www variants rank separately).
    let path = p.page_address;
    try {
      const u = new URL(p.page_address);
      path = u.protocol === "https:" && !u.hostname.startsWith("www.") ? u.pathname + u.search : p.page_address.replace(/^https:\/\//, "");
    } catch {}
    const priced = !p.metrics.organic!.estimated_paid_traffic_cost && etv > 0 ? null : k.trafficValue;
    return { url: p.page_address, path, keywords: k.keywords, traffic: k.traffic, share: total > 0 ? etv / total : 0, top10: k.top10, trafficValue: priced };
  });
}

/** The first path segment, or "/" for the home page: the section a page belongs to. */
export function sectionOf(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {}
  const first = path.split("/").filter(Boolean)[0];
  return first ? `/${first}/` : "/";
}

export interface SectionRow {
  [key: string]: unknown;
  section: string;
  pages: number;
  keywords: number;
  traffic: number;
  share: number;
  /** The section's page with the most traffic. */
  topPage: string;
}

/**
 * Top pages added up by first folder (/blog/, /tools/), most traffic first: which kinds of page earn a
 * domain its traffic. It covers only the pages given, not every page the domain has.
 */
export function sectionRows(pages: PageRow[]): SectionRow[] {
  const bySection = new Map<string, SectionRow & { topTraffic: number }>();
  for (const p of pages) {
    const key = sectionOf(p.url);
    const row = bySection.get(key) ?? { section: key, pages: 0, keywords: 0, traffic: 0, share: 0, topPage: p.url, topTraffic: -1 };
    row.pages += 1;
    row.keywords += p.keywords;
    row.traffic += p.traffic;
    row.share += p.share;
    if (p.traffic > row.topTraffic) {
      row.topPage = p.url;
      row.topTraffic = p.traffic;
    }
    bySection.set(key, row);
  }
  return [...bySection.values()]
    .sort((a, b) => b.traffic - a.traffic)
    .map((r) => ({ section: r.section, pages: r.pages, keywords: r.keywords, traffic: r.traffic, share: r.share, topPage: r.topPage }));
}

export interface CompetitorRow {
  [key: string]: unknown;
  domain: string;
  common: number;
  avgPosition: number;
  keywords: number;
  traffic: number;
  /** Common keywords as a share of the target's own keyword count. */
  overlap: number;
}

const isSelf = (domain: string, target: string) => domain === target || domain === `www.${target}`;

/** Competitors without the target itself. The target's keyword count falls back to its own row in the response. */
export function competitorRows(items: CompetitorsResult["items"], target: string, targetKeywords: number | null = null): CompetitorRow[] {
  const own = targetKeywords ?? (items ?? []).find((c) => isSelf(c.domain, target))?.full_domain_metrics?.organic?.count ?? null;
  return (items ?? [])
    .filter((c) => !isSelf(c.domain, target))
    .map((c) => ({
      domain: c.domain,
      common: c.intersections,
      avgPosition: Math.round(c.avg_position * 10) / 10,
      keywords: c.full_domain_metrics?.organic?.count ?? 0,
      traffic: Math.round(c.full_domain_metrics?.organic?.etv ?? 0),
      overlap: own ? Math.min(c.intersections / own, 1) : 0,
    }));
}

/** Columns with a value in at least one row. A column in `keep` stays regardless; with no rows they all stay, so the table keeps its shape. */
export function withData<C extends { key: string }>(columns: C[], rows: readonly object[], keep: readonly string[] = []): C[] {
  if (!rows.length) return columns;
  return columns.filter((c) => {
    if (keep.includes(c.key)) return true;
    return rows.some((r) => {
      const v = (r as Record<string, unknown>)[c.key];
      return v != null && v !== "";
    });
  });
}

/* ---------- Keyword gap ---------- */

export const GAP_TABS = {
  shared: { label: "Shared", help: "Every domain ranks" },
  missing: { label: "Missing", help: "All the others rank, you don't" },
  weak: { label: "Weak", help: "You rank below every other domain that ranks" },
  strong: { label: "Strong", help: "You rank above every other domain that ranks" },
  untapped: { label: "Untapped", help: "At least one other domain ranks, you don't" },
  unique: { label: "Unique", help: "Only you rank" },
  all: { label: "All", help: "Every keyword any domain ranks for" },
} as const;

export type GapTab = keyof typeof GAP_TABS;

export interface GapRow extends KeywordRow {
  /** Position per domain, in the order the domains were given; null = not ranking. */
  positions: (number | null)[];
  tabs: GapTab[];
}

/** Which gap tabs a keyword belongs to. Index 0 is "you". */
export function gapTabs(positions: (number | null)[]): GapTab[] {
  const [mine, ...others] = positions;
  const ranking = others.filter((p): p is number => p != null);
  const tabs: GapTab[] = ["all"];
  if (mine != null && ranking.length === others.length && others.length > 0) tabs.push("shared");
  if (mine == null && ranking.length > 0) {
    tabs.push("untapped");
    if (ranking.length === others.length) tabs.push("missing");
  }
  if (mine != null && ranking.length > 0) {
    if (ranking.every((p) => p < mine)) tabs.push("weak");
    if (ranking.every((p) => p > mine)) tabs.push("strong");
  }
  if (mine != null && ranking.length === 0) tabs.push("unique");
  return tabs;
}

/**
 * Builds the gap table from each domain's ranked keywords (index 0 is "you").
 * Lost and non-organic rankings are ignored; positions are organic (rank_group). Metrics come from whichever domain's data saw the keyword first.
 */
export function buildGap(perDomain: (RankedKeywordItem[] | null | undefined)[]): GapRow[] {
  const rows = new Map<string, GapRow>();
  perDomain.forEach((items, d) => {
    for (const item of items ?? []) {
      if (item.ranked_serp_element.is_lost || !isOrganic(item)) continue;
      const kw = item.keyword_data.keyword;
      let row = rows.get(kw);
      if (!row) {
        const base = toKeywordRow(item.keyword_data);
        row = { ...base, kd: base.kd ?? knownKd(item.ranked_serp_element.keyword_difficulty), positions: perDomain.map(() => null), tabs: [] };
        rows.set(kw, row);
      }
      const pos = item.ranked_serp_element.serp_item.rank_group;
      const prev = row.positions[d];
      row.positions[d] = prev == null ? pos : Math.min(prev, pos);
    }
  });
  for (const row of rows.values()) row.tabs = gapTabs(row.positions);
  return [...rows.values()].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
}

export function gapCounts(rows: GapRow[]): Record<GapTab, number> {
  const counts = Object.fromEntries(Object.keys(GAP_TABS).map((t) => [t, 0])) as Record<GapTab, number>;
  for (const r of rows) for (const t of r.tabs) counts[t] += 1;
  return counts;
}
