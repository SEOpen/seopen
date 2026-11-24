// Pure backlinks logic: no database or network, so it is unit-testable.
import type { BacklinkItem, BacklinksSummary, IntersectionItem, NewLostItem, ReferringDomainItem } from "./types";

/** Backlinks API list price: $0.024 per request plus $0.000036 per returned row. */
export function estimateCostUsd(rows = 0): number {
  return 0.024 + rows * 0.000036;
}

/** Share of backlinks without rel=nofollow (0–1), or null when there are none. */
export function dofollowShare(s: Pick<BacklinksSummary, "backlinks" | "referring_links_attributes">): number | null {
  if (!s.backlinks) return null;
  const nofollow = s.referring_links_attributes?.nofollow ?? 0;
  return Math.max(0, Math.min(1, (s.backlinks - nofollow) / s.backlinks));
}

export function stripWww(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/** True when `date` is less than `days` days before `now`. */
export function isWithinDays(date: string | null | undefined, days: number, now: Date = new Date()): boolean {
  if (!date) return false;
  const t = new Date(date).getTime();
  return Number.isFinite(t) && now.getTime() - t < days * 86_400_000;
}

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

/** "alphanote.example" → "alphanote", "shop.example.co.uk" → "example". */
export function brandTerm(domain: string): string {
  const parts = stripWww(domain).split(".").filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? "";
  let end = parts.length - 1;
  if (parts.length >= 3 && parts[end].length === 2 && SECOND_LEVEL.has(parts[end - 1])) end--;
  return parts[end - 1];
}

/**
 * A filter link: the page with one param set, the others kept, and the default value left out. `run`
 * never travels, because on these pages it means "spend now".
 */
export function filterHref(basePath: string, params: Record<string, string | undefined>, name: string, value: string, defaultValue: string): string {
  const entries = Object.entries({ ...params, run: undefined, [name]: value === defaultValue ? undefined : value }).filter((e): e is [string, string] => !!e[1]);
  const next = new URLSearchParams(entries);
  return `${basePath}${next.size ? `?${next}` : ""}`;
}

/** The columns with something to show. A column empty in every row says nothing, so it goes. */
export function columnsWithData<C extends { key: string }>(columns: C[], rows: Record<string, unknown>[]): C[] {
  if (!rows.length) return columns;
  return columns.filter((c) => rows.some((r) => r[c.key] != null && r[c.key] !== ""));
}

// ---------------------------------------------------------------------------
// Anchor classification

export type AnchorClass = "branded" | "url" | "exact" | "partial" | "generic" | "other";

const GENERIC_ANCHORS = new Set([
  "",
  "click here",
  "here",
  "this",
  "link",
  "website",
  "web site",
  "site",
  "visit",
  "visit site",
  "visit website",
  "visit our site",
  "visit our website",
  "homepage",
  "home page",
  "home",
  "read more",
  "learn more",
  "more",
  "more info",
  "source",
  "download",
  "download here",
  "official site",
  "official website",
  "check it out",
  "go",
  "this site",
  "this website",
  "this link",
]);

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean);

/**
 * Our own anchor taxonomy:
 * - url: the anchor is a bare URL or hostname
 * - branded: mentions the brand (domain name without its TLD)
 * - generic: "click here", "website" and similar, or empty
 * - exact: equals one of the money keywords
 * - partial: contains every word of a money keyword
 * - other: anything else
 */
export function classifyAnchor(anchor: string | null | undefined, domain: string, keywords: string[] = []): AnchorClass {
  const a = (anchor ?? "").trim().toLowerCase();
  if (GENERIC_ANCHORS.has(a.replace(/[^a-z0-9\s]+/g, "").replace(/\s+/g, " ").trim())) return "generic";
  if (/^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/.test(a)) return "url";
  const brand = brandTerm(domain);
  if (brand && brand.length >= 3 && squash(a).includes(squash(brand))) return "branded";
  const anchorWords = words(a);
  for (const kw of keywords) {
    if (squash(kw) && squash(kw) === squash(a)) return "exact";
  }
  for (const kw of keywords) {
    const kwWords = words(kw);
    if (kwWords.length && kwWords.every((w) => anchorWords.includes(w))) return "partial";
  }
  return "other";
}

// ---------------------------------------------------------------------------
// New/lost timeseries

export interface NewLostPoint {
  date: string;
  newDomains: number;
  lostDomains: number;
  newBacklinks: number;
  lostBacklinks: number;
}

/** Monthly rows from timeseries_new_lost_summary, oldest first. Lost counts are negative. */
export function toNewLostSeries(items: NewLostItem[] | null | undefined): NewLostPoint[] {
  return [...(items ?? [])]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((i) => ({
      date: i.date.slice(0, 7),
      newDomains: i.new_referring_domains ?? 0,
      lostDomains: -(i.lost_referring_domains ?? 0),
      newBacklinks: i.new_backlinks ?? 0,
      lostBacklinks: -(i.lost_backlinks ?? 0),
    }));
}

/**
 * Request window for the timeseries: the 12 months up to the Sunday that ended last week (UTC).
 * Pinning date_to to one day a week keeps the cache key stable for the week-long TTL. It must be
 * the Sunday, not this week's Monday: DataForSEO refuses a date_to that isn't before today, so a
 * Monday date_to failed every Monday.
 */
export function timeseriesWindow(today: Date): { date_from: string; date_to: string } {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 1);
  const from = new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), 1));
  return { date_from: from.toISOString().slice(0, 10), date_to: d.toISOString().slice(0, 10) };
}

// ---------------------------------------------------------------------------
// Link review ("toxic" links)

export type ReviewLabel = "ok" | "review" | "risky";

/** What a customer reads for each label, on the badges, the filter, the CSV and in the Guide. The URL keeps the keys. */
export const REVIEW_LABELS: Record<ReviewLabel, string> = { risky: "Risky", review: "To review", ok: "OK" };

/** TLDs that cheap link networks use far more often than real sites. */
export const SUSPICIOUS_TLDS = new Set([
  "shop", "site", "website", "store", "space", "online", "xyz", "top", "click", "link", "buzz", "icu",
  "monster", "cfd", "sbs", "rest", "bar", "fun", "info", "biz", "loan", "work", "gq", "tk", "ml", "cf", "ga",
]);

/** Anchor words typical of paid-link spam and off-topic money niches. */
const SPAM_ANCHOR_TERMS = [
  "seo", "backlink", "backlinks", "casino", "slot", "slots", "betting", "poker", "viagra", "cialis", "loan", "loans",
  "payday", "porn", "xxx", "escort", "crypto", "forex", "replica", "essay", "rank higher",
];

export interface DomainSignals {
  domain: string;
  /** Provider spam score of the links from this domain, 0–100. */
  spamScore: number | null;
  /** Provider rank of the referring domain itself, 0–1000. */
  rank: number | null;
  /** Backlinks from this domain to the target. */
  backlinks: number;
  tld: string;
  /** A sample anchor from this domain, when known. */
  anchor: string | null;
  /** How many linking domains share this domain's /24 subnet (including itself). */
  subnetPeers: number;
}

export interface ReviewResult {
  score: number;
  label: ReviewLabel;
  reasons: string[];
}

/**
 * Transparent link-risk score from 0 to 100. Each rule adds points and a reason:
 * spam score ≥60 (+40) or ≥30 (+20); suspicious TLD (+20); spammy anchor (+25);
 * 50+ links from one domain (+15); 3+ linking domains on one non-CDN /24 subnet (+15); rank under 10 (+10).
 * Labels: risky ≥50, review ≥25, otherwise ok.
 */
export function scoreDomain(s: DomainSignals): ReviewResult {
  let score = 0;
  const reasons: string[] = [];
  if (s.spamScore != null && s.spamScore >= 60) {
    score += 40;
    reasons.push(`High spam score (${s.spamScore})`);
  } else if (s.spamScore != null && s.spamScore >= ELEVATED_SPAM) {
    score += 20;
    reasons.push(`Elevated spam score (${s.spamScore})`);
  }
  if (SUSPICIOUS_TLDS.has(s.tld)) {
    score += 20;
    reasons.push(`Link-network TLD (.${s.tld})`);
  }
  const anchor = (s.anchor ?? "").toLowerCase();
  const term = SPAM_ANCHOR_TERMS.find((t) => (t.includes(" ") ? anchor.includes(t) : words(anchor).includes(t)));
  if (term) {
    score += 25;
    reasons.push(`Spammy link text ("${term}")`);
  }
  if (s.backlinks >= 50) {
    score += 15;
    reasons.push(`Site-wide: ${s.backlinks} links from one domain`);
  }
  if (s.subnetPeers >= 3) {
    score += 15;
    reasons.push(`${s.subnetPeers} linking domains on one subnet`);
  }
  if (s.rank != null && s.rank < 10) {
    score += 10;
    reasons.push(`Very low domain strength (${s.rank})`);
  }
  score = Math.min(score, 100);
  return { score, label: score >= 50 ? "risky" : score >= 25 ? "review" : "ok", reasons };
}

export interface ReviewRow extends DomainSignals, ReviewResult {
  firstSeen: string | null;
  urlFrom: string | null;
}

/** Shared CDN ranges (Cloudflare) host unrelated sites side by side, so they don't count as a link network. */
const CDN_RANGES: [string, number][] = [
  ["104.16.0.0", 12], ["172.64.0.0", 13], ["188.114.96.0", 20], ["162.158.0.0", 15], ["141.101.64.0", 18],
  ["108.162.192.0", 18], ["190.93.240.0", 20], ["198.41.128.0", 17], ["173.245.48.0", 20], ["103.21.244.0", 22],
  ["103.22.200.0", 22], ["103.31.4.0", 22], ["131.0.72.0", 22], ["197.234.240.0", 22],
];

const ipToInt = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);

export function isCdnIp(ip: string): boolean {
  const n = ipToInt(ip);
  return CDN_RANGES.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(ipToInt(base) / 2 ** (32 - bits)));
}

/** "/24" subnet of an IPv4 address, or null for IPv6, missing or CDN addresses. */
export function subnetOf(ip: string | null | undefined): string | null {
  if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip) || isCdnIp(ip)) return null;
  return ip.split(".").slice(0, 3).join(".");
}

/**
 * Join referring domains with one sample backlink per domain and score each domain.
 * Sorted riskiest first.
 */
export function buildReview(domains: ReferringDomainItem[], sampleLinks: BacklinkItem[]): ReviewRow[] {
  const linkByDomain = new Map<string, BacklinkItem>();
  for (const l of sampleLinks) {
    const d = stripWww(l.domain_from);
    if (!linkByDomain.has(d)) linkByDomain.set(d, l);
  }
  const subnetCounts = new Map<string, number>();
  for (const l of linkByDomain.values()) {
    const s = subnetOf(l.domain_from_ip);
    if (s) subnetCounts.set(s, (subnetCounts.get(s) ?? 0) + 1);
  }
  return domains
    .map((d) => {
      const domain = stripWww(d.domain);
      const link = linkByDomain.get(domain);
      const subnet = subnetOf(link?.domain_from_ip);
      const signals: DomainSignals = {
        domain,
        spamScore: d.backlinks_spam_score ?? link?.backlink_spam_score ?? null,
        // referring_domains.rank measures links to the target; the sample link carries the domain's own rank.
        rank: link?.domain_from_rank ?? d.rank,
        backlinks: d.backlinks,
        tld: domain.split(".").pop() ?? "",
        anchor: link?.anchor ?? null,
        subnetPeers: subnet ? (subnetCounts.get(subnet) ?? 1) : 1,
      };
      return { ...signals, ...scoreDomain(signals), firstSeen: d.first_seen, urlFrom: link?.url_from ?? null };
    })
    .sort((a, b) => b.score - a.score || b.backlinks - a.backlinks);
}

// ---------------------------------------------------------------------------
// Disavow file

/** Google-format disavow file: comment header, then one "domain:" line per domain, deduped and sorted. */
export function buildDisavowFile(domains: string[], opts: { target: string; date: Date }): string {
  const unique = [...new Set(domains.map((d) => stripWww(d.trim())).filter(Boolean))].sort();
  const lines = [
    `# Disavow file for ${opts.target}`,
    `# Generated by SEOpen on ${opts.date.toISOString().slice(0, 10)}. ${unique.length} domain${unique.length === 1 ? "" : "s"}.`,
    "# Review before uploading to Search Console's disavow links tool. SEOpen never submits it.",
    ...unique.map((d) => `domain:${d}`),
  ];
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Most-linked pages

export interface LinkedPageRow {
  [key: string]: unknown;
  url: string;
  referringDomains: number;
  dofollow: number;
  /** The strongest domains linking to the page, strongest first, at most five. */
  topDomains: { domain: string; rank: number | null }[];
  /** Up to five distinct link texts, in the order the links came. */
  anchors: string[];
}

/** Query parameters that only track where a click came from, so they don't make another page. */
const TRACKING_PARAM = /^(utm_\w+|ref|ref_src|fbclid|gclid|mc_cid|mc_eid)$/i;

/**
 * One address per page, so links to its variants count together: https, no www, no fragment and no
 * tracking parameters. Subdomains stay apart. An address that isn't http(s) comes back as it was.
 */
export function pageAddress(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return url;
  u.protocol = "https:";
  u.hostname = stripWww(u.hostname);
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
  return u.toString();
}

/**
 * Group one-link-per-domain backlinks by the page they point to, most referring domains first: the
 * pages that earn a site its links. Variants of one address count as one page (`pageAddress`). Counts
 * cover only the links given (the strongest LIST_LIMIT).
 */
export function linkedPageRows(items: BacklinkItem[]): LinkedPageRow[] {
  const byPage = new Map<string, LinkedPageRow & { anchorSet: Set<string> }>();
  for (const b of items) {
    const url = pageAddress(b.url_to);
    const page = byPage.get(url) ?? { url, referringDomains: 0, dofollow: 0, topDomains: [], anchors: [], anchorSet: new Set<string>() };
    page.referringDomains += 1;
    if (b.dofollow) page.dofollow += 1;
    page.topDomains.push({ domain: stripWww(b.domain_from), rank: b.domain_from_rank });
    const anchor = b.anchor?.trim();
    if (anchor && page.anchorSet.size < 5) page.anchorSet.add(anchor.slice(0, 120));
    byPage.set(url, page);
  }
  return [...byPage.values()]
    .sort((a, b) => b.referringDomains - a.referringDomains)
    .map(({ anchorSet, ...p }) => ({ ...p, topDomains: p.topDomains.sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0)).slice(0, 5), anchors: [...anchorSet] }));
}

// ---------------------------------------------------------------------------
// Link gap

export interface GapRow {
  domain: string;
  /** Number of competitors this domain links to. */
  competitorCount: number;
  competitors: string;
  /**
   * Highest rank of this domain's links to any competitor (0–1000). domain_intersection rates the links,
   * not the domain, so it isn't the domain's own rank and moves with the competitors compared.
   */
  rank: number | null;
  backlinks: number;
  spamScore: number | null;
  firstSeen: string | null;
}

/** A spam score from here up is worth a look before trusting the domain (`scoreDomain` adds points for it). */
export const ELEVATED_SPAM = 30;

/** Whether a link gap prospect's spam score is elevated: a link farm links to everyone, so it tops a list sorted by competitors. */
export const isSpammyProspect = (r: Pick<GapRow, "spamScore">) => (r.spamScore ?? 0) >= ELEVATED_SPAM;

/**
 * Whether `domain` is one of `sites` under another name: the same brand on another TLD or subdomain,
 * such as seranking.ru for seranking.com. A competitor's own site isn't an outreach prospect. Brands
 * under 3 letters are too short to tell apart.
 */
export function isSameBrand(domain: string, sites: string[]): boolean {
  const brand = brandTerm(domain);
  return brand.length >= 3 && sites.some((s) => brandTerm(s) === brand);
}

/**
 * Sites that link to nearly every site on the web, so they top any link gap without being anyone's
 * outreach target: search engines, social networks, link shorteners and the web archive. Their links
 * come from search pages, profiles, posts and copies, not from a person who could be asked. A short list
 * on purpose: it names the ones a link gap keeps meeting, and spam scores and the `isBroadLinker` signal
 * catch the long tail. A subdomain counts (sites.google.com, m.facebook.com).
 */
export const UNIVERSAL_LINKERS = [
  "google.com",
  "bing.com",
  "yahoo.com",
  "duckduckgo.com",
  "yandex.ru",
  "yandex.com",
  "baidu.com",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "t.co",
  "linkedin.com",
  "pinterest.com",
  "reddit.com",
  "youtube.com",
  "tiktok.com",
  "bit.ly",
  "archive.org",
];

/** Search engines run a site per country (google.de, google.co.uk), so their brand on any TLD counts. */
const SEARCH_BRANDS = new Set(["google", "bing", "yahoo", "yandex", "baidu", "duckduckgo"]);

/** Whether `domain` is one of the `UNIVERSAL_LINKERS`, a subdomain of one, or a search engine on another TLD. */
export function isUniversalLinker(domain: string): boolean {
  const d = stripWww(domain);
  return UNIVERSAL_LINKERS.some((u) => d === u || d.endsWith(`.${u}`)) || SEARCH_BRANDS.has(brandTerm(d));
}

/**
 * Link rank from which a domain that links to every competitor looks like a general host rather than a
 * site in the niche. A judgment, not a measured cut-off: no saved link gap had a universal linker in it
 * to measure against (2026-11-20). It only moves rows down, never hides them, so a wrong guess costs order.
 */
export const BROAD_LINK_RANK = 500;

/** Fewest competitors for "links to all of them" to mean anything: with one or two, every row does. */
export const BROAD_MIN_COMPETITORS = 3;

/**
 * Whether a link gap row looks like a site that links to everyone: it links to every one of at least
 * BROAD_MIN_COMPETITORS competitors with a link rank of BROAD_LINK_RANK or more. A big generic host
 * (a news aggregator, a directory, a platform's user pages) does that; a niche blog that links to all of
 * them ranks lower. Uses only what domain_intersection returns: the provider gives no count of how many
 * sites a domain links to.
 */
export function isBroadLinker(r: Pick<GapRow, "competitorCount" | "rank">, competitors: number): boolean {
  return competitors >= BROAD_MIN_COMPETITORS && r.competitorCount >= competitors && (r.rank ?? 0) >= BROAD_LINK_RANK;
}

/**
 * Merge per-competitor domain_intersection results (each a single-target call that
 * excludes our domain) into one prospect list: domains linking to more competitors first,
 * with the ones whose spam score is elevated after all the rest.
 */
export function mergeGap(perCompetitor: { competitor: string; items: IntersectionItem[] }[]): GapRow[] {
  const byDomain = new Map<string, GapRow & { set: Set<string> }>();
  for (const { competitor, items } of perCompetitor) {
    for (const item of items) {
      for (const v of Object.values(item.domain_intersection ?? {})) {
        if (!v?.target) continue;
        const domain = stripWww(v.target);
        const row = byDomain.get(domain) ?? {
          domain,
          competitorCount: 0,
          competitors: "",
          rank: null,
          backlinks: 0,
          spamScore: null,
          firstSeen: null,
          set: new Set<string>(),
        };
        row.set.add(competitor);
        row.backlinks += v.backlinks ?? 0;
        if (v.rank != null) row.rank = Math.max(row.rank ?? 0, v.rank);
        if (v.backlinks_spam_score != null) row.spamScore = Math.max(row.spamScore ?? 0, v.backlinks_spam_score);
        if (v.first_seen && (!row.firstSeen || v.first_seen < row.firstSeen)) row.firstSeen = v.first_seen;
        byDomain.set(domain, row);
      }
    }
  }
  return [...byDomain.values()]
    .map(({ set, ...r }) => ({ ...r, competitorCount: set.size, competitors: [...set].sort().join(", ") }))
    .sort((a, b) => Number(isSpammyProspect(a)) - Number(isSpammyProspect(b)) || b.competitorCount - a.competitorCount || (b.rank ?? 0) - (a.rank ?? 0));
}

export interface PreparedGap {
  /** The prospects in order: the rest first, then likely general hosts (`broadLinker`), then spam when it's included. */
  rows: (GapRow & { broadLinker: boolean })[];
  /** Your own and the competitors' sites under another TLD or subdomain, left out. */
  ownSites: string[];
  /** Search engines, social networks and the like (`isUniversalLinker`), left out. */
  universalLinkers: string[];
  /** Prospects with an elevated spam score left out: 0 when `includeSpam`. */
  spamHidden: number;
}

/**
 * Turn `mergeGap`'s rows into the prospects the link_gap tool and the Link gap page list: your own and the
 * competitors' sites and the universal linkers are left out and named, likely general hosts go after the
 * rest, and spam is left out and counted, or with `includeSpam` listed last. The sort is stable, so each
 * group keeps `mergeGap`'s order. `competitors` are the ones compared, without `target`.
 */
export function prepareGap(merged: GapRow[], target: string, competitors: string[], { includeSpam = false }: { includeSpam?: boolean } = {}): PreparedGap {
  const own = (r: GapRow) => isSameBrand(r.domain, [target, ...competitors]);
  const others = merged.filter((r) => !own(r));
  const prospects = others.filter((r) => !isUniversalLinker(r.domain));
  const group = (r: GapRow & { broadLinker: boolean }) => (isSpammyProspect(r) ? 2 : r.broadLinker ? 1 : 0);
  const rows = (includeSpam ? prospects : prospects.filter((r) => !isSpammyProspect(r))).map((r) => ({ ...r, broadLinker: isBroadLinker(r, competitors.length) })).sort((a, b) => group(a) - group(b));
  return {
    rows,
    ownSites: merged.filter(own).map((r) => r.domain),
    universalLinkers: others.filter((r) => isUniversalLinker(r.domain)).map((r) => r.domain),
    spamHidden: prospects.length - rows.length,
  };
}
