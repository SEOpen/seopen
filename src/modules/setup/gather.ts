import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { aiPrompts, rankKeywords } from "@/db/schema";
import { TTL } from "@/lib/dataforseo/client";
import { plainActionFailure } from "@/lib/dataforseo/failure-copy";
import { creditsFor, isFree, showsDollarCosts } from "@/lib/billing/gates";
import { FREE_PLAN_REFUSAL } from "@/lib/billing/spend";
import { keywordGate, loadBillingWorkspace, projectActionRefusal, promptGate } from "@/lib/billing/workspace";
import { placesNamed } from "@/lib/dataforseo/places";
import { placeKey, regionAbbr, type Place } from "@/lib/dataforseo/place-names";
import { OpError, refused } from "@/lib/ops";
import { listCompetitors, type Project } from "@/lib/projects";
import { inScope, projectScope } from "@/lib/workspace";
import type { RankedKeywordItem } from "@/modules/ai/types";
import type { KeywordData } from "@/modules/keywords/types";
import { load, type DfsSpec, type Loaded } from "@/modules/keywords/dfs";
import { labsCost, suggestionsSpec, type Market } from "@/modules/keywords/requests";
import { SEARCH_PRICE_USD } from "@/modules/local/grid";
import type { MapsResult } from "@/modules/local/types";
import { fetchErrorMessage, safeFetch } from "@/lib/web/fetch";
import { visibleText } from "@/lib/web/html";
import { addressTowns, detectBusinessType, isBusinessType, matchTowns, namesToLookUp, townCandidates, type SetupBusiness } from "./business";
import { brandTokens, competitorQueries, homepageSeeds, mapsKeywords, MAX_SETUP_KEYWORDS, PROPOSAL_LIMITS, suggestedSearches, type MapsSearch, type SetupInput, type SetupSearch } from "./propose";
import { REVIEW_QUOTE_USD, type ReviewQuote } from "./refine";
import { setupReviewQuote } from "./refine.server";
import { COMPARE_PAGE, comparedSites, linkedTopics, serviceNames, siteFacts, type SiteFacts } from "./site";

/**
 * Everything the guided setup reads before it proposes anything:
 * the homepage, the keywords the site ranks for, keywords Google relates to it, and its competitors
 * (made from those and the homepage, so that lookup runs last), plus what the project already has
 * and how much the plan still allows. A local business's competitors come from Google Maps in its
 * towns, anything else's from its own comparison page and Google's results across the country for
 * the searches the user named. The DataForSEO calls are research, quoted in credits first
 * (`setupQuote`) and run only when the user asks.
 */

export const SETUP_KEYWORDS_LIMIT = 100;
export const SETUP_IDEAS_LIMIT = 100;
export const SETUP_COMPETITORS_LIMIT = 30;
/** Keywords kept per search the user named. Billed per row returned, and the proposal shows 20 ideas at most. */
export const SETUP_SEARCH_LIMIT = 100;
/** Fewer searches than this say little, so a site further down them still counts: in a small market rivals rank at 28 and 29. */
const FEW_QUERIES = 10;
const HOMEPAGE_BYTES = 1_000_000;

const market = (p: Project): Market => ({ locationCode: p.locationCode, languageCode: p.languageCode });

/** Keywords the site ranks for in the top 30, by volume: the same request as AI visibility's suggestions, so they share the cache. */
export function setupKeywordsSpec(domain: string, m: Market): DfsSpec {
  return {
    path: "dataforseo_labs/google/ranked_keywords/live",
    task: {
      location_code: m.locationCode,
      language_code: m.languageCode,
      limit: SETUP_KEYWORDS_LIMIT,
      target: domain,
      filters: [["ranked_serp_element.serp_item.rank_group", "<=", 30]],
      order_by: ["keyword_data.keyword_info.search_volume,desc"],
    },
    ttlSeconds: TTL.week,
    estUsd: labsCost(SETUP_KEYWORDS_LIMIT),
    module: "domains",
  };
}

/** Keywords Google relates to the site, most relevant first, including ones it doesn't rank for. */
export function setupIdeasSpec(domain: string, m: Market): DfsSpec {
  return {
    path: "dataforseo_labs/google/keywords_for_site/live",
    task: {
      target: domain,
      location_code: m.locationCode,
      language_code: m.languageCode,
      limit: SETUP_IDEAS_LIMIT,
      filters: [["keyword_info.search_volume", ">", 0]],
      order_by: ["relevance,desc", "keyword_info.search_volume,desc"],
    },
    ttlSeconds: TTL.week,
    estUsd: labsCost(SETUP_IDEAS_LIMIT),
    module: "domains",
  };
}

/**
 * Domains in Google's results (organic and the map pack) for the setup's searches, most visible
 * first, where their middle position is in the top 20, or the top 30 for a handful of searches.
 * Billed per domain returned, not per keyword.
 */
export function setupCompetitorsSpec(keywords: string[], m: Market): DfsSpec {
  return {
    path: "dataforseo_labs/google/serp_competitors/live",
    task: {
      keywords,
      location_code: m.locationCode,
      language_code: m.languageCode,
      item_types: ["organic", "local_pack"],
      limit: SETUP_COMPETITORS_LIMIT,
      filters: [["median_position", "<=", keywords.length < FEW_QUERIES ? 30 : 20]],
      order_by: ["rating,desc"],
    },
    ttlSeconds: TTL.week,
    estUsd: labsCost(SETUP_COMPETITORS_LIMIT),
    module: "domains",
  };
}

/** What Google knows that contains one search the user named. */
export const setupSearchSpec = (keyword: string, m: Market): DfsSpec => suggestionsSpec(keyword, m, SETUP_SEARCH_LIMIT);

/** A local business's competitors: one Google Maps search, the same shape as finding a listing in Local SEO. */
export function setupMapsSpec(keyword: string, m: Market): DfsSpec {
  return {
    path: "serp/google/maps/live/advanced",
    task: { keyword, location_code: m.locationCode, language_code: m.languageCode, device: "desktop", depth: 20 },
    ttlSeconds: TTL.week,
    estUsd: SEARCH_PRICE_USD,
    module: "local",
  };
}

/** Search volumes for the homepage's own searches, which Google's lists for the site often lack. */
export function setupVolumesSpec(keywords: string[], m: Market): DfsSpec {
  return {
    path: "dataforseo_labs/google/keyword_overview/live",
    task: { keywords, location_code: m.locationCode, language_code: m.languageCode },
    ttlSeconds: TTL.month,
    estUsd: labsCost(keywords.length),
    module: "keywords",
  };
}

/** Town searches at most, and homepage searches to get volumes for at most: what a quote counts before it knows them. */
const MAPS_SEARCHES_AT_MOST = 3;
const VOLUMES_AT_MOST = 12;

interface SerpCompetitorsResult {
  items?: { domain: string; keywords_count: number }[] | null;
}

type RankedLoad = Loaded<{ items?: RankedKeywordItem[] | null }>;
type IdeasLoad = Loaded<{ items?: KeywordData[] | null }>;

/** The searches a proposal looks up: only a business that isn't local names them. */
const searchesOf = (business: SetupBusiness) => (business.type === "local" ? [] : business.searches);

/** Each search with what Google knows that contains it; rows with no volume say nothing about demand. */
const searchRows = (searches: string[], loads: IdeasLoad[]): SetupSearch[] =>
  searches.map((keyword, i) => ({ keyword, ideas: ideaRows(loads[i]).filter((k) => k.volume > 0) }));

const rankedRows = (l: RankedLoad) =>
  l.state === "ready" ? (l.results[0]?.items ?? []).map((i) => ({ keyword: i.keyword_data.keyword, volume: i.keyword_data.keyword_info?.search_volume ?? 0 })) : [];
const ideaRows = (l: IdeasLoad) => (l.state === "ready" ? (l.results[0]?.items ?? []).map((i) => ({ keyword: i.keyword, volume: i.keyword_info?.search_volume ?? 0 })) : []);

export interface SetupQuote {
  /** Research credits the lookups will use; 0 when both are already paid for. */
  credits: number;
  /** Dollars, only where the app shows them (the owner's workspace). */
  usd: number | null;
  /** Claude's review of the proposal, where setup asks Claude: free with how many are left, or in `credits` above. */
  review: ReviewQuote | null;
}

/** The saved answer, if the user has confirmed one. */
export function savedBusiness(project: Project): SetupBusiness | null {
  return isBusinessType(project.businessType) ? { type: project.businessType, towns: project.servedTowns ?? [], searches: project.setupSearches ?? [] } : null;
}

/** A first guess at what people search for to find this business, free. A local business keeps it for if the answer changes. */
export async function guessSearches(project: Project, type: SetupBusiness["type"], home?: { site: SiteFacts | null; html: string | null }): Promise<string[]> {
  const { site, html } = home ?? (await readHomepage(project.domain));
  return suggestedSearches({
    site: withBusiness(site, { type: "other", towns: [], searches: [] }, project),
    domain: project.domain,
    projectName: project.name,
    type,
    topics: html ? linkedTopics(html, project.domain) : [],
  });
}

/** The site with what the user confirmed in place of what the page said: a business that isn't local has no towns to search in. */
function withBusiness(site: SiteFacts | null, business: SetupBusiness, project: Project): SiteFacts | null {
  if (business.type !== "local") return site && { ...site, business: null, cities: [] };
  const base = site ?? { title: null, description: null, headings: [], business: null, cities: [] };
  const main = business.towns[0];
  return { ...base, cities: business.towns, business: main ? { name: base.business?.name ?? project.name, city: main } : null };
}

/**
 * One Google Maps search per town, made from that town: the same search made from the middle of
 * the country came back empty (docs/dataforseo.md, "Local SEO"). A town that isn't on the country's
 * list can't be searched from, so it's left out and named in a note.
 */
async function mapsSearches(project: Project, site: SiteFacts | null): Promise<{ keyword: string; spec: DfsSpec }[]> {
  const towns = await townCities(project.locationCode, site?.cities ?? []);
  const located = [...towns.keys()];
  if (!site || !located.length) return [];
  const m = market(project);
  const searched = { ...site, cities: located, business: site.business && { ...site.business, city: located[0] } };
  return mapsKeywords({ domain: project.domain, projectName: project.name, site: searched }).map((keyword, i) => ({
    keyword,
    spec: setupMapsSpec(keyword, { ...m, locationCode: towns.get(located[i])!.code }),
  }));
}

/** The Google Maps searches and volumes a local business's proposal needs, or the country-wide competitors lookup for anything else. */
async function rivalSpecs(project: Project, business: SetupBusiness, site: SiteFacts | null, keywords: SetupInput["keywords"], ideas: SetupInput["ideas"], searches: SetupSearch[]): Promise<DfsSpec[]> {
  const m = market(project);
  if (business.type === "local") {
    const seeds = homepageSeeds(site, brandTokens(project.name, project.domain, site));
    return [...(await mapsSearches(project, site)).map((s) => s.spec), ...(seeds.length ? [setupVolumesSpec(seeds, m)] : [])];
  }
  const queries = competitorQueries({ domain: project.domain, projectName: project.name, site, keywords, ideas, searches });
  return queries.length ? [setupCompetitorsSpec(queries, m)] : [];
}

/**
 * What making a proposal costs this workspace now: nothing for lookups it already paid for. The
 * competitors lookups ask about searches made from the other two and the homepage, so they can only
 * be found in the cache once those are; until then they're counted at their most.
 */
export async function setupQuote(project: Project, business: SetupBusiness): Promise<SetupQuote> {
  const ws = await loadBillingWorkspace(project.workspaceId);
  const opts = { run: false, workspaceId: project.workspaceId };
  const searched = searchesOf(business);
  const [ranked, related, ...searchLoads] = await Promise.all([
    load<{ items?: RankedKeywordItem[] | null }>(setupKeywordsSpec(project.domain, market(project)), opts),
    load<{ items?: KeywordData[] | null }>(setupIdeasSpec(project.domain, market(project)), opts),
    ...searched.map((keyword) => load<{ items?: KeywordData[] | null }>(setupSearchSpec(keyword, market(project)), opts)),
  ]) as [RankedLoad, IdeasLoad, ...IdeasLoad[]];
  const atMost = business.type === "local" ? MAPS_SEARCHES_AT_MOST * SEARCH_PRICE_USD + labsCost(VOLUMES_AT_MOST) : labsCost(SETUP_COMPETITORS_LIMIT);
  let rivals = atMost;
  if ([ranked, related, ...searchLoads].every((l) => l.state === "ready")) {
    const site = await businessSite(project, business, await readHomepage(project.domain));
    const loaded = await Promise.all((await rivalSpecs(project, business, site, rankedRows(ranked), ideaRows(related), searchRows(searched, searchLoads))).map((spec) => load(spec, opts)));
    rivals = loaded.reduce((sum, l) => sum + (l.state === "idle" ? l.estUsd : 0), 0);
  }
  const review = await setupReviewQuote(ws);
  const lookups = [ranked, related, ...searchLoads].reduce((sum, l) => sum + (l.state === "idle" ? l.estUsd : 0), rivals);
  // A review past the free ones spends credits too. It isn't known yet whether the answer is cached, so it's counted.
  const usd = lookups + (review && !review.free ? REVIEW_QUOTE_USD : 0);
  return { credits: usd > 0 ? creditsFor(usd) : 0, usd: showsDollarCosts(ws) ? usd : null, review };
}

/** The homepage's facts, or why it couldn't be read. Never throws: a proposal works without it. */
async function readHomepage(domain: string): Promise<{ site: SiteFacts | null; html: string | null; error: string | null }> {
  try {
    const res = await safeFetch(`https://${domain}/`, { maxBytes: HOMEPAGE_BYTES });
    if (res.status >= 400) return { site: null, html: null, error: `The homepage answered ${res.status}.` };
    return { site: siteFacts(res.body), html: res.body, error: null };
  } catch (err) {
    return { site: null, html: null, error: fetchErrorMessage(err) };
  }
}

/** The site as a proposal sees it. A local business's list of services can live on its own page when the homepage has none. */
async function businessSite(project: Project, business: SetupBusiness, home: { site: SiteFacts | null; html: string | null }): Promise<SiteFacts | null> {
  const site = withBusiness(home.site, business, project);
  if (business.type === "local" && site && !site.services?.length && home.html) {
    const page = await linkedPage(project.domain, home.html, /^\/services?\/?$/i);
    if (page) site.services = serviceNames(page);
  }
  return site;
}

/** A page the homepage links to on the same site, read for free, or null. */
async function linkedPage(domain: string, html: string, path: RegExp): Promise<string | null> {
  for (const m of html.matchAll(/href=["']([^"'#?]+)["']/gi)) {
    let url: URL;
    try {
      url = new URL(m[1], `https://${domain}/`);
    } catch {
      continue;
    }
    if (url.hostname.replace(/^www\./, "") !== domain.replace(/^www\./, "") || !path.test(url.pathname)) continue;
    try {
      const res = await safeFetch(url.href, { maxBytes: HOMEPAGE_BYTES });
      return res.status < 400 ? res.body : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The sites the business's own comparison page compares it with, read for free. */
async function comparedOnSite(project: Project, html: string | null): Promise<string[]> {
  const page = html && (await linkedPage(project.domain, html, COMPARE_PAGE));
  return page ? comparedSites(page, project.domain) : [];
}

export interface BusinessGuess extends SetupBusiness {
  /** What the guess was read from, for the card: the homepage couldn't be read when this is false. */
  read: boolean;
}

/**
 * A first guess at the business from its site, free: the homepage, and its contact page for the
 * address, which is the surest sign of the main town. Each named place is checked against the
 * country's list of towns, so a heading's capitals aren't taken for one.
 */
export async function guessBusiness(project: Project): Promise<BusinessGuess> {
  const { site, html } = await readHomepage(project.domain);
  if (!site || !html) return { type: "other", towns: [], searches: await guessSearches(project, "other", { site, html }), read: false };
  const contact = site.business ? null : await linkedPage(project.domain, html, /^\/contact(-us)?\/?$/i);
  const candidates = [...(contact ? addressTowns(visibleText(contact)) : []), ...townCandidates([site.title, site.description, ...site.headings].filter((l): l is string => !!l))];
  const places = await placesNamed(project.locationCode, namesToLookUp(candidates));
  const named = matchTowns(candidates, places);
  const towns = [...new Set([...site.cities, ...named])].filter((t, i, all) => all.findIndex((o) => placeKey(o.split(",")[0]) === placeKey(t.split(",")[0])) === i).slice(0, 5);
  const type = detectBusinessType(html, { hasLocalBusiness: !!site.business, towns });
  return { type, towns, searches: await guessSearches(project, type, { site, html }), read: true };
}

/** The country's list's city for each town that has one, in the towns' order: what Google Maps and rank tracking can search from. */
async function townCities(locationCode: number, towns: string[]): Promise<Map<string, Place>> {
  const names = towns.map((t) => t.split(",")[0].trim());
  const places = await placesNamed(locationCode, names);
  const out = new Map<string, Place>();
  for (const town of towns) {
    const [name, region] = town.split(",").map((p) => p.trim());
    const here = places.filter((p) => placeKey(p.name.split(",")[0]) === placeKey(name));
    const wanted = region?.toLowerCase();
    const fit = wanted ? here.filter((p) => p.name.split(",").slice(1).some((part) => part.trim().toLowerCase() === wanted || regionAbbr(part) === wanted)) : here;
    const city = fit[0] ?? (here.length === 1 ? here[0] : null);
    if (city) out.set(town, city);
  }
  return out;
}

/** The most of `cap` that `fits(n)` allows, found in a few checks rather than one per item. */
async function largestFitting(cap: number, fits: (n: number) => Promise<boolean>): Promise<number> {
  if (cap <= 0 || !(await fits(1))) return 0;
  let [lo, hi] = [1, cap];
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (await fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface Gathered {
  input: SetupInput;
  /** Why the homepage couldn't be read, when it couldn't. */
  homepageError: string | null;
  /** Cities a local business's rank tracking could search from, main town first. Empty once the project has one. */
  trackingCities: Place[];
}

/** One Google Maps result's businesses, as the proposal compares them. */
const mapsItems = (result: MapsResult | undefined): MapsSearch["items"] =>
  (result?.items ?? [])
    .filter((i) => i.type === "maps_search" && i.title)
    .sort((a, b) => (a.rank_group ?? 0) - (b.rank_group ?? 0))
    .map((i) => ({ domain: i.domain ?? null, title: i.title ?? null, category: i.category ?? null, categories: i.additional_categories ?? [] }));

/** Runs the lookups (spending the quoted credits) and reads the homepage and the project's state. */
export async function gatherSetup(project: Project, business: SetupBusiness): Promise<Gathered> {
  const scope = projectScope(project);
  const refusal = await projectActionRefusal(scope, { research: true });
  if (refusal) throw refused(refusal);
  const ws = await loadBillingWorkspace(scope.workspaceId);
  if (isFree(ws)) throw refused(FREE_PLAN_REFUSAL);
  const opts = { run: true, workspaceId: scope.workspaceId, projectId: scope.projectId };
  // A refused or failed paid call: say why rather than propose from half the data.
  const failed = (err: unknown): never => {
    throw new OpError(plainActionFailure(err, "setup.gather"));
  };

  const searched = searchesOf(business);
  const lookups = (
    Promise.all([
      load<{ items?: RankedKeywordItem[] | null }>(setupKeywordsSpec(project.domain, market(project)), opts),
      load<{ items?: KeywordData[] | null }>(setupIdeasSpec(project.domain, market(project)), opts),
      ...searched.map((keyword) => load<{ items?: KeywordData[] | null }>(setupSearchSpec(keyword, market(project)), opts)),
    ]) as Promise<[RankedLoad, IdeasLoad, ...IdeasLoad[]]>
  ).catch(failed);
  const [home, existingCompetitors, existingKeywords, existingPrompts, [ranked, related, ...searchLoads]] = await Promise.all([
    readHomepage(project.domain),
    listCompetitors(scope),
    db.select({ keyword: rankKeywords.keyword }).from(rankKeywords).where(inScope(rankKeywords, scope)),
    db.select({ prompt: aiPrompts.prompt }).from(aiPrompts).where(inScope(aiPrompts, scope)),
    lookups,
  ]);

  const keywords = rankedRows(ranked);
  const ideas = ideaRows(related);
  const site = await businessSite(project, business, home);
  const m = market(project);
  const local = business.type === "local";
  const searches = searchRows(searched, searchLoads);
  const compared = local ? [] : await comparedOnSite(project, home.html);
  const queries = local ? [] : competitorQueries({ domain: project.domain, projectName: project.name, site, keywords, ideas, searches });
  const mapsWanted = local ? await mapsSearches(project, site) : [];
  const located = local ? await townCities(project.locationCode, business.towns) : new Map<string, Place>();
  const seeds = local ? homepageSeeds(site, brandTokens(project.name, project.domain, site)) : [];
  const [rivals, mapsLoads, volumes, keywordRoom, promptRoom, trackingCities] = await Promise.all([
    queries.length ? load<SerpCompetitorsResult>(setupCompetitorsSpec(queries, m), opts).catch(failed) : null,
    Promise.all(mapsWanted.map((s) => load<MapsResult>(s.spec, opts))).catch(failed),
    seeds.length ? load<{ items?: KeywordData[] | null }>(setupVolumesSpec(seeds, m), opts).catch(failed) : null,
    largestFitting(MAX_SETUP_KEYWORDS, async (n) => (await keywordGate(ws, scope.projectId, n)).ok),
    largestFitting(PROPOSAL_LIMITS.prompts, async (n) => (await promptGate(ws, n)).ok),
    project.cityCode == null ? [...new Map([...located.values()].map((c) => [c.code, c])).values()] : [],
  ]);
  const competitors =
    rivals?.state === "ready" ? (rivals.results[0]?.items ?? []).map((i) => ({ domain: i.domain, keywords: i.keywords_count })) : [];
  const maps = mapsWanted.map(({ keyword }, i) => {
    const l = mapsLoads[i];
    return { keyword, items: mapsItems(l?.state === "ready" ? l.results[0] : undefined) };
  });

  return {
    input: {
      domain: project.domain,
      projectName: project.name,
      type: business.type,
      locationCode: project.locationCode,
      site,
      keywords,
      ideas,
      competitors,
      maps,
      unknownTowns: business.towns.filter((t) => !located.has(t)),
      seedVolumes: volumes?.state === "ready" ? ideaRows(volumes) : [],
      searches,
      comparedSites: compared,
      existing: { competitors: existingCompetitors, keywords: existingKeywords.map((k) => k.keyword), prompts: existingPrompts.map((p) => p.prompt) },
      room: { keywords: keywordRoom, prompts: promptRoom },
    },
    homepageError: home.error,
    trackingCities,
  };
}

export interface SetupState {
  competitors: number;
  keywords: number;
  prompts: number;
}

/** What the project tracks now, so a return visit shows what an earlier setup (or the user) added. */
export async function setupState(project: Project): Promise<SetupState> {
  const scope = projectScope(project);
  const [competitors, keywords, prompts] = await Promise.all([
    listCompetitors(scope),
    db.$count(rankKeywords, and(inScope(rankKeywords, scope), eq(rankKeywords.active, true))),
    db.$count(aiPrompts, and(inScope(aiPrompts, scope), eq(aiPrompts.active, true))),
  ]);
  return { competitors: competitors.length, keywords, prompts };
}
