import type { SeriesPoint } from "@/lib/chart-rule";
import { serpTarget } from "@/lib/dataforseo/serp-target";
import type { KeywordData, MonthlySearch, RelatedResult, SerpItem, SerpResult } from "./types";

/** One keyword with the metrics every keyword table shows. Plain data, safe to pass to client components. */
export interface KeywordRow {
  [key: string]: unknown;
  keyword: string;
  volume: number | null;
  kd: number | null;
  cpc: number | null;
  competition: number | null;
  intent: string | null;
  words: number;
}

export function wordCount(keyword: string) {
  return keyword.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Labs keyword difficulty, or null when it isn't known. Labs sends 0 for a keyword it hasn't scored: the
 * same keyword comes back 0 from keyword_suggestions and 16 to 47 from ranked_keywords (QA, 2026-11-17),
 * and 0s sit on keywords whose top results average 11 linking domains. So a 0 reads as unknown, not easy.
 */
export function knownKd(value: number | null | undefined): number | null {
  return value ? value : null;
}

/** Labs sends CPC as a float32, such as 9.930000305175781: to the cent. */
const toCents = (usd: number | null | undefined) => (usd == null ? null : Math.round(usd * 100) / 100);

export function toKeywordRow(d: KeywordData): KeywordRow {
  return {
    keyword: d.keyword,
    volume: d.keyword_info?.search_volume ?? null,
    kd: knownKd(d.keyword_properties?.keyword_difficulty),
    cpc: toCents(d.keyword_info?.cpc),
    competition: d.keyword_info?.competition ?? null,
    intent: d.search_intent_info?.main_intent ?? null,
    words: wordCount(d.keyword),
  };
}

/** Related keywords repeat across depths; keep each keyword once, at its shallowest depth. */
export function relatedRows(items: RelatedResult["items"]): (KeywordRow & { depth: number })[] {
  const byKeyword = new Map<string, KeywordRow & { depth: number }>();
  for (const item of items ?? []) {
    const prev = byKeyword.get(item.keyword_data.keyword);
    if (!prev || item.depth < prev.depth) byKeyword.set(item.keyword_data.keyword, { ...toKeywordRow(item.keyword_data), depth: item.depth });
  }
  return [...byKeyword.values()];
}

/** The last `months` months of search volume, oldest first, on real dates. A month with no number stays null, so the line breaks there. */
export function volumeTrend(monthly: MonthlySearch[] | null | undefined, months = 12): SeriesPoint[] {
  return [...(monthly ?? [])]
    .sort((a, b) => b.year - a.year || b.month - a.month)
    .slice(0, months)
    .reverse()
    .map((m) => ({ date: `${m.year}-${String(m.month).padStart(2, "0")}-01`, value: m.search_volume }));
}

/** The columns with something to show: one empty in every row says nothing, so it hides. */
export function columnsWithData<C extends { key: string }>(columns: C[], rows: Record<string, unknown>[]): C[] {
  return columns.filter((c) => rows.some((r) => r[c.key] != null && r[c.key] !== ""));
}

export interface SerpRow {
  [key: string]: unknown;
  position: number;
  type: string;
  domain: string | null;
  url: string | null;
  title: string | null;
  isProject: boolean;
  /** True when `url` is only the site's origin, because Google hid the real link (src/lib/dataforseo/serp-target.ts). */
  originOnly: boolean;
  /** For an origin-only row, Google's display path after the origin, which may be cut short. Null otherwise. */
  breadcrumb: string | null;
}

const bare = (d: string | null | undefined) => (d ?? "").toLowerCase().replace(/^www\./, "");

/** "3 sources cited": an AI Overview's distinct references, its parts' included, since DataForSEO nests most of them there. */
function aiOverviewTitle(item: SerpItem): string {
  const urls = new Set<string>();
  for (const r of [...(item.references ?? []), ...(item.items ?? []).flatMap((i) => i.references ?? [])]) urls.add(r.url || r.domain);
  return urls.size ? `${urls.size} ${urls.size === 1 ? "source" : "sources"} cited` : "No sources cited";
}

/** Top results in page order. Organic rows get their organic rank; features keep their absolute slot. */
export function serpRows(result: SerpResult | null, projectDomain?: string | null): SerpRow[] {
  const project = bare(projectDomain);
  return (result?.items ?? []).map((item) => {
    const target = serpTarget(item);
    const domain = target.domain ? bare(target.domain) : null;
    return {
      position: item.type === "organic" ? item.rank_group : item.rank_absolute,
      type: item.type,
      domain,
      url: target.url,
      title: item.title ?? (item.type === "ai_overview" ? aiOverviewTitle(item) : null),
      isProject: !!project && !!domain && (domain === project || domain.endsWith(`.${project}`)),
      originOnly: target.originOnly,
      breadcrumb: target.breadcrumb,
    };
  });
}

/** "people_also_ask" → "People also ask". */
export function featureLabel(type: string) {
  const s = type.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from how i in is it my of on or the to vs what when where which who why will with you your".split(" "),
);

export interface WordGroup {
  word: string;
  count: number;
  volume: number;
}

/**
 * Groups keywords by the words they share, the way a topic sidebar does: every word
 * (and two-word phrase) that appears in at least `min` keywords, excluding stopwords
 * and the seed's own words. Sorted by keyword count, then volume.
 */
export function wordGroups(rows: Pick<KeywordRow, "keyword" | "volume">[], seed = "", min = 2): WordGroup[] {
  const seedWords = new Set(seed.toLowerCase().split(/\s+/).filter(Boolean));
  const groups = new Map<string, WordGroup>();
  for (const row of rows) {
    const tokens = row.keyword.toLowerCase().split(/\s+/).filter(Boolean);
    const terms = new Set<string>();
    tokens.forEach((t, i) => {
      if (!STOPWORDS.has(t) && !seedWords.has(t)) terms.add(t);
      const next = tokens[i + 1];
      if (next && !(seedWords.has(t) && seedWords.has(next)) && !STOPWORDS.has(t) && !STOPWORDS.has(next)) terms.add(`${t} ${next}`);
    });
    for (const term of terms) {
      const g = groups.get(term) ?? { word: term, count: 0, volume: 0 };
      g.count += 1;
      g.volume += row.volume ?? 0;
      groups.set(term, g);
    }
  }
  return [...groups.values()].filter((g) => g.count >= min).sort((a, b) => b.count - a.count || b.volume - a.volume || a.word.localeCompare(b.word));
}

/** True when `term` (one or two words) appears as whole words in `keyword`. */
export function hasTerm(keyword: string, term: string) {
  return ` ${keyword.toLowerCase().split(/\s+/).join(" ")} `.includes(` ${term} `);
}

export type Range = [min: number | null, max: number | null];

export interface IdeaFilters {
  volume?: Range;
  kd?: Range;
  cpc?: Range;
  words?: Range;
  intents?: string[];
  include?: string[];
  exclude?: string[];
}

function inRange(value: number | null, range: Range | undefined) {
  if (!range) return true;
  const [min, max] = range;
  if (min == null && max == null) return true;
  if (value == null) return false;
  return (min == null || value >= min) && (max == null || value <= max);
}

export function filterRows<T extends KeywordRow>(rows: T[], f: IdeaFilters): T[] {
  return rows.filter(
    (r) =>
      inRange(r.volume, f.volume) &&
      inRange(r.kd, f.kd) &&
      inRange(r.cpc, f.cpc) &&
      inRange(r.words, f.words) &&
      (!f.intents?.length || (r.intent != null && f.intents.includes(r.intent))) &&
      (f.include ?? []).every((t) => hasTerm(r.keyword, t)) &&
      !(f.exclude ?? []).some((t) => hasTerm(r.keyword, t)),
  );
}
