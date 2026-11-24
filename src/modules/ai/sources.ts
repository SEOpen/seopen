/** Who owns a cited site, and which cited sites look like competitors we don't track. Pure functions, no I/O. */
import type { AiCitation } from "@/db/schema/ai";
import { citationLabel, hostMatches, readCitation, siteOf, type Brand } from "./detect";

export type Ownership = "yours" | "competitor" | "third_party";

export const OWNERSHIP_LABEL: Record<Ownership, string> = { yours: "Yours", competitor: "Competitor", third_party: "Third party" };

/** The tracked brand a cited domain belongs to, or null for a third-party site. */
export function brandOfDomain(domain: string, brands: Brand[]): Brand | null {
  return brands.find((b) => b.domains.some((d) => hostMatches(domain, d))) ?? null;
}

export function ownershipOf(domain: string, brands: Brand[]): Ownership {
  const b = brandOfDomain(domain, brands);
  return !b ? "third_party" : b.own ? "yours" : "competitor";
}

/**
 * Sites that are never suggested as competitors: encyclopedias, social networks, forums, video,
 * marketplaces, app stores, maps, and review or listing directories. They are cited for every kind
 * of business, so they say nothing about who competes with you. Subdomains count
 * (en.wikipedia.org, apps.apple.com). Keep this list short and obvious; anything else a user can
 * simply not add.
 */
export const PLATFORM_SITES = [
  // Reference, social, forums, video
  "wikipedia.org", "wikihow.com", "britannica.com", "reddit.com", "quora.com", "medium.com", "substack.com",
  "youtube.com", "vimeo.com", "tiktok.com", "facebook.com", "instagram.com", "linkedin.com", "x.com", "twitter.com",
  "threads.net", "bsky.app", "pinterest.com", "nextdoor.com", "github.com", "stackoverflow.com", "stackexchange.com",
  // Portfolios
  "dribbble.com", "behance.net",
  // Search, maps, marketplaces, app stores
  "google.com", "bing.com", "yahoo.com", "duckduckgo.com", "apple.com", "microsoft.com", "amazon.com", "ebay.com", "etsy.com", "mapquest.com",
  // Review and listing directories
  "yelp.com", "tripadvisor.com", "trustpilot.com", "bbb.org", "yellowpages.com", "angi.com", "angieslist.com",
  "homeadvisor.com", "houzz.com", "thumbtack.com", "porch.com", "expertise.com", "g2.com", "capterra.com",
  "getapp.com", "softwareadvice.com", "producthunt.com", "alternativeto.net", "upwork.com", "fiverr.com", "bark.com",
  "manta.com", "chamberofcommerce.com", "birdeye.com", "crunchbase.com", "glassdoor.com", "indeed.com",
  // Agency directories
  "clutch.co", "designrush.com", "upcity.com", "sortlist.com", "goodfirms.co", "themanifest.com", "agencyspotter.com",
];

export const isPlatformSite = (domain: string) => PLATFORM_SITES.some((p) => hostMatches(domain, p));

/** One answer's citations, with what the sources page needs to count them. */
export interface CitedAnswer {
  promptId: number;
  platform: string;
  mentioned: boolean | null;
  citations: AiCitation[] | null;
}

/**
 * Most-cited domains and pages across these answers. A Gemini redirect counts under the site its title
 * names; one that hides its site is listed as a page, owned by nobody, and counted under no domain, so it
 * can't read as a site worth reaching out to. Tracked competitors and your own site are never third party.
 */
export function citedSources(answers: readonly CitedAnswer[], brands: Brand[]) {
  type Agg = { citations: number; prompts: Set<number>; platforms: Set<string>; withoutUs: number };
  const empty = (): Agg => ({ citations: 0, prompts: new Set(), platforms: new Set(), withoutUs: 0 });
  const count = (a: Agg, r: CitedAnswer) => {
    a.citations++;
    if (!r.mentioned) a.withoutUs++;
    a.prompts.add(r.promptId);
    a.platforms.add(r.platform);
  };
  const domains = new Map<string, Agg>();
  const urls = new Map<string, Agg & { url: string; domain: string | null; title: string | null; label: string }>();
  for (const r of answers) {
    for (const stored of r.citations ?? []) {
      const c = readCitation(stored);
      if (c.domain) {
        const d = domains.get(c.domain) ?? empty();
        count(d, r);
        domains.set(c.domain, d);
      }
      const u = urls.get(c.url) ?? { ...empty(), url: c.url, domain: c.domain, title: c.title, label: citationLabel(c) };
      count(u, r);
      urls.set(c.url, u);
    }
  }
  const toRow = (domain: string | null, v: Agg) => {
    const b = domain ? brandOfDomain(domain, brands) : null;
    return {
      ownership: domain ? ownershipOf(domain, brands) : null,
      citations: v.citations,
      withoutUs: v.withoutUs,
      prompts: v.prompts.size,
      platforms: [...v.platforms],
      brand: b?.name ?? null,
      own: b?.own ?? false,
    };
  };
  return {
    domains: [...domains.entries()].map(([domain, v]) => ({ domain, ...toRow(domain, v), ownership: ownershipOf(domain, brands) })).sort((a, b) => b.citations - a.citations),
    urls: [...urls.values()].map((u) => ({ ...toRow(u.domain, u), domain: u.domain, url: u.url, title: u.title, label: u.label })).sort((a, b) => b.citations - a.citations),
  };
}

export interface SuggestedCompetitor {
  /** The cited site, e.g. "redoakpavers.com". */
  domain: string;
  /** Answers that cite the site at least once. */
  answers: number;
  /** Prompts whose answers cite it. */
  prompts: number;
}

/**
 * Sites cited in the most answers that are neither ours nor a tracked competitor, skipping
 * PLATFORM_SITES. Hosts are grouped by site (shop.example.com counts as example.com). Only sites
 * cited in at least `minAnswers` answers are suggested.
 */
export function suggestCompetitors(
  rows: { promptId: number; citations: AiCitation[] | null }[],
  brands: Brand[],
  { limit = 10, minAnswers = 2 } = {},
): SuggestedCompetitor[] {
  const agg = new Map<string, { answers: number; prompts: Set<number> }>();
  for (const r of rows) {
    const sites = new Set(
      (r.citations ?? [])
        .flatMap((stored) => readCitation(stored).domain ?? [])
        .filter((domain) => !brandOfDomain(domain, brands))
        .map((domain) => siteOf(domain))
        .filter((d) => d && !brandOfDomain(d, brands) && !isPlatformSite(d)),
    );
    for (const site of sites) {
      const a = agg.get(site) ?? { answers: 0, prompts: new Set<number>() };
      a.answers++;
      a.prompts.add(r.promptId);
      agg.set(site, a);
    }
  }
  return [...agg.entries()]
    .map(([domain, a]) => ({ domain, answers: a.answers, prompts: a.prompts.size }))
    .filter((s) => s.answers >= minAnswers)
    .sort((a, b) => b.answers - a.answers || b.prompts - a.prompts || a.domain.localeCompare(b.domain))
    .slice(0, limit);
}
