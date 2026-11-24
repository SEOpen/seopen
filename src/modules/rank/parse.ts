import type { RankDomainHit, RankSerpItem } from "@/db/schema/rank";
import { serpTarget } from "@/lib/dataforseo/serp-target";
import { hasSearchOperators } from "@/modules/keywords/lookup-quote";
import type { SerpAdvancedResult, SerpItem, SerpReference } from "./types";

/** What we keep from one SERP. Pure, so it is unit tested against fixtures. */
export interface ParsedSerp {
  position: number | null;
  rankAbsolute: number | null;
  url: string | null;
  ownUrls: RankDomainHit[];
  serpFeatures: string[];
  ownedFeatures: string[];
  aiOverview: boolean;
  aiOverviewCited: boolean;
  domains: Record<string, RankDomainHit>;
  top: RankSerpItem[];
  seResultsCount: number | null;
  checkedAt: Date;
}

/** "WWW.Example.com." → "example.com". */
export function bareHost(host: string | null | undefined): string | null {
  if (!host) return null;
  const h = host.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return h || null;
}

/** The result's real host and URL, unwrapping google.com/goto links (src/lib/dataforseo/serp-target.ts). */
function targetOf(ref: SerpReference | null | undefined): { host: string | null; url: string | null } {
  if (!ref) return { host: null, url: null };
  const t = serpTarget(ref);
  if (t.domain) return { host: bareHost(t.domain), url: t.url };
  if (!t.url) return { host: null, url: null };
  try {
    return { host: bareHost(new URL(t.url).hostname), url: t.url };
  } catch {
    return { host: null, url: t.url };
  }
}

const hostOf = (ref: SerpReference | null | undefined) => targetOf(ref).host;

/** True when `host` is `domain` or one of its subdomains. */
export function matchesDomain(host: string | null, domain: string): boolean {
  if (!host) return false;
  const d = bareHost(domain)!;
  return host === d || host.endsWith(`.${d}`);
}

/** Every domain reference inside a SERP feature (AI Overview sources, carousel entries, …). */
function featureRefs(item: SerpItem): SerpReference[] {
  const refs: SerpReference[] = [];
  if (item.domain || item.url) refs.push(item);
  for (const r of item.references ?? []) refs.push(r);
  for (const l of item.links ?? []) refs.push(l);
  for (const sub of item.items ?? []) {
    refs.push(sub);
    for (const r of sub.references ?? []) refs.push(r);
    for (const l of sub.links ?? []) refs.push(l);
  }
  return refs;
}

/** DataForSEO "2026-10-29 04:55:26 +00:00" → Date. */
function parseDfsDate(s: string | null | undefined): Date {
  if (!s) return new Date();
  const d = new Date(s.replace(" ", "T").replace(" ", ""));
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Turns a task_get/advanced result into our row shape. Positions are organic
 * positions (rank_group), which is what people mean by "we rank #3".
 */
export function parseSerp(result: SerpAdvancedResult, projectDomain: string): ParsedSerp {
  const items = result.items ?? [];
  const features = new Set<string>();
  const owned = new Set<string>();
  const domains: Record<string, RankDomainHit> = {};
  const ownUrls: RankDomainHit[] = [];
  let aiOverview = false;
  let aiOverviewCited = false;
  let own: { p: number; abs: number | null; u: string } | null = null;

  for (const item of items) {
    if (item.type === "organic") {
      const { host, url } = targetOf(item);
      const p = item.rank_group ?? null;
      if (!host || p == null || !url) continue;
      if (!domains[host] || domains[host].p > p) domains[host] = { p, u: url };
      if (matchesDomain(host, projectDomain)) {
        if (!ownUrls.some((o) => o.u === url)) ownUrls.push({ p, u: url });
        if (!own || p < own.p) own = { p, abs: item.rank_absolute ?? null, u: url };
      }
      continue;
    }
    features.add(item.type);
    const refs = featureRefs(item);
    const ours = refs.some((r) => matchesDomain(hostOf(r), projectDomain));
    if (ours) owned.add(item.type);
    if (item.type === "ai_overview") {
      aiOverview = true;
      if (ours) aiOverviewCited = true;
    }
  }

  const top: RankSerpItem[] = items.slice(0, 20).map((i) => ({
    type: i.type,
    pos: (i.type === "organic" ? i.rank_group : i.rank_absolute) ?? 0,
    abs: i.rank_absolute ?? 0,
    domain: hostOf(i),
    url: targetOf(i).url,
    title: i.title ?? null,
  }));

  return {
    position: own?.p ?? null,
    rankAbsolute: own?.abs ?? null,
    url: own?.u ?? null,
    ownUrls: ownUrls.sort((a, b) => a.p - b.p),
    serpFeatures: [...features].sort(),
    ownedFeatures: [...owned].sort(),
    aiOverview,
    aiOverviewCited,
    domains,
    top,
    seResultsCount: result.se_results_count ?? null,
    checkedAt: parseDfsDate(result.datetime),
  };
}

/** Our task tag: "seopen:rank:r12:k34". Lets us recognise our tasks in tasks_ready. */
export function makeTag(runId: number, keywordId: number): string {
  return `seopen:rank:r${runId}:k${keywordId}`;
}

export function parseTag(tag: string | null | undefined): { runId: number; keywordId: number } | null {
  const m = /^seopen:rank:r(\d+):k(\d+)$/.exec(tag ?? "");
  return m ? { runId: Number(m[1]), keywordId: Number(m[2]) } : null;
}

const cleanKeyword = (r: string) => r.trim().replace(/\s+/g, " ").toLowerCase();

/** Trims, collapses whitespace, lowercases and dedupes keywords ("Mac  Notes" and "mac notes" merge). */
export function normalizeKeywords(raw: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const r of raw) {
    const k = cleanKeyword(r);
    if (k && k.length <= 200) seen.add(k);
  }
  return [...seen];
}

/** The entries, as given, that repeat an earlier one once case and spacing are folded. normalizeKeywords drops these. */
export function repeatedKeywords(raw: Iterable<string>): string[] {
  const seen = new Set<string>();
  const repeats: string[] = [];
  for (const r of raw) {
    const k = cleanKeyword(r);
    if (!k) continue;
    if (seen.has(k)) repeats.push(r);
    else seen.add(k);
  }
  return repeats;
}

/**
 * Splits off keywords with search operators such as `site:` or `intitle:`. DataForSEO bills a SERP
 * task that uses one at 5× (docs/dataforseo.md), and it isn't a ranking anyone searches for, so rank
 * tracking doesn't add them.
 */
export function withoutOperators(keywords: string[]): { keywords: string[]; operators: string[] } {
  return { keywords: keywords.filter((k) => !hasSearchOperators(k)), operators: keywords.filter(hasSearchOperators) };
}

/** Splits pasted text into unique keywords: one per line or comma separated, lowercased, trimmed. */
export function parseKeywordList(text: string): string[] {
  return normalizeKeywords(text.split(/[\n,]+/));
}

/**
 * Caps how many keywords one add may start tracking. Keywords already tracked
 * don't count toward the cap (they only get tags merged), so adding a big saved
 * list again picks up the next batch instead of re-adding the first one.
 */
export function capNewKeywords(
  keywords: string[],
  tracked: ReadonlySet<string>,
  cap: number,
): { keywords: string[]; added: number; skipped: number } {
  const out: string[] = [];
  let added = 0;
  let skipped = 0;
  for (const k of keywords) {
    if (tracked.has(k)) out.push(k);
    else if (added < cap) {
      out.push(k);
      added++;
    } else skipped++;
  }
  return { keywords: out, added, skipped };
}

export function parseTags(text: string): string[] {
  return [...new Set(text.split(/[,\n]+/).map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}
