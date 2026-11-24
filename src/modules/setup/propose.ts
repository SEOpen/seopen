import { locationName } from "@/lib/dataforseo/locations";
import { regionAbbr } from "@/lib/dataforseo/place-names";
import { formatNumber } from "@/lib/format";
import { plural } from "@/lib/ops";
import { keywordToPrompt, PERSON, suggestTopics } from "@/modules/ai/prompts";
import { isPlatformSite } from "@/modules/ai/sources";
import { MAX_SEARCHES, type BusinessType } from "./business";
import { foreignPlace } from "./places";
import { townOf, type SiteBusiness, type SiteFacts } from "./site";

/**
 * The plain setup proposal: competitors
 * from Google, the keywords the site ranks for, keyword ideas it doesn't rank for yet (the
 * homepage's services in its towns first), question prompts made from them, and the business from
 * the homepage. Each section follows the kind of business (`SetupInput.type`): a local one is
 * compared with the businesses on Google Maps in its towns and asked about by town, the others with
 * the sites Google shows across the country, starting from the searches the user named. Brand
 * searches and namesake domains are kept out: they share a name with the site, not a business. Pure,
 * so it's tested without a database; the user reviews it and the ops check every item again when
 * it's applied.
 */

/** At most this many of each, before the plan's room is applied. */
export const PROPOSAL_LIMITS = { competitors: 5, keywords: 30, ideas: 20, prompts: 10 } as const;

/** The most keywords one Apply adds: ranked ones, ideas and the user's own together. */
export const MAX_SETUP_KEYWORDS = 50;

/** Brand searches proposed for rank tracking, at most: enough to watch the brand's own rank. */
export const MAX_BRANDED_KEYWORDS = 3;

/** Searches checked for competitors, at most. The lookup takes 200 and costs the same either way. */
export const MAX_COMPETITOR_QUERIES = 50;

/** Below this many searches a month across a business's keywords, the proposal says the market is small. A judgement, not a measurement. */
const SMALL_MARKET_SEARCHES = 1_000;

/** A search the user named, with what Google knows that contains it. */
export interface SetupSearch {
  keyword: string;
  /** Keywords containing it, with monthly searches. Empty when Google has no data for it, which is how a slogan shows itself. */
  ideas: { keyword: string; volume: number }[];
}

/** One Google Maps search for a local business's service in one of its towns. */
export interface MapsSearch {
  keyword: string;
  /** The businesses it found, in Google's order. */
  items: { domain: string | null; /** The business's name on Google Maps. */ title?: string | null; category: string | null; categories: string[] }[];
}

export interface SetupInput {
  domain: string;
  projectName: string;
  /** What kind of business it is; without one, the rules that don't depend on the kind. */
  type?: BusinessType;
  /** A local business's Google Maps searches, main town first. Its competitors come from these. */
  maps?: MapsSearch[];
  /** Towns the country's list doesn't have, so Google Maps couldn't be searched from them. */
  unknownTowns?: string[];
  /** Search volumes for the homepage's searches, which Google's lists often lack. */
  seedVolumes?: { keyword: string; volume: number }[];
  /** What the user says people search for to find a business that isn't local. */
  searches?: SetupSearch[];
  /** Sites the business's own comparison page compares it with: it named them, so they come first. */
  comparedSites?: string[];
  /** The project's market (DataForSEO location code), so ideas naming another country can be left out. */
  locationCode?: number;
  site: SiteFacts | null;
  /** Keywords the site ranks for, with monthly search volume. */
  keywords: { keyword: string; volume: number }[];
  /** Keywords Google relates to the site, most relevant first; some it ranks for already. */
  ideas: { keyword: string; volume: number }[];
  /** Domains in Google's results for `competitorQueries(input)`, with how many of those searches each ranks for. */
  competitors: { domain: string; keywords: number }[];
  /** What the project already has, left out of the proposal. */
  existing: { competitors: string[]; keywords: string[]; prompts: string[] };
  /** How many more keywords (up to MAX_SETUP_KEYWORDS) and prompts the plan allows. */
  room: { keywords: number; prompts: number };
}

/** The longest business name `selectionSchema` takes for a competitor. */
export const MAX_COMPETITOR_NAME = 80;

export interface ProposedCompetitor {
  domain: string;
  reason: string;
  /** The business's own name, when the lookup gave one (Google Maps does; the country-wide competitor list gives only a domain). */
  name?: string;
}

export interface ProposedKeyword {
  keyword: string;
  /** Monthly searches; null for a keyword the user typed in or one taken from the homepage. */
  volume: number | null;
  tag: string | null;
  /**
   * Where it comes from when that isn't only Google's lists, each of which starts ticked: the
   * homepage's title and towns, or the searches the user named and what Google knows that contains
   * them. "unknown" is a search the user named that Google has no data for,
   * which may be a slogan, so it starts unticked.
   */
  source?: "homepage" | "search" | "unknown";
}

export interface ProposedPrompt {
  prompt: string;
  keyword: string;
  topic: string | null;
}

export interface Proposal {
  competitors: ProposedCompetitor[];
  /** Competitors the project tracks already (left out of `competitors`), shown so the section isn't empty for no reason. */
  trackedCompetitors: string[];
  keywords: ProposedKeyword[];
  /** Keywords the site doesn't rank for yet. See `ProposedKeyword.source` for which start ticked in the wizard: they share the keyword room. */
  ideas: ProposedKeyword[];
  /** How many keywords Apply can add in all: ranked ones, ideas and the user's own. */
  keywordRoom: number;
  /** How many keywords the site ranks for, tracked or not, so an empty Rankings list doesn't say it ranks for none. */
  rankedKeywords: number;
  prompts: ProposedPrompt[];
  local: SiteBusiness | null;
  /** The cities a local business could track rank from, main town first. Filled in by `gather.ts`, which has the list of towns. */
  trackingCities?: { code: number; name: string }[];
  /** Why a section is short or empty, in words for the user. */
  notes: string[];
}

const cleanKeyword = (k: string) => k.toLowerCase().replace(/\s+/g, " ").trim();

const squash = (s: string) => s.toLowerCase().replace(/[\s.\-_']+/g, "");

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A phrase as a search keyword: lower case, "&" as "and", punctuation as spaces ("St. Clair" → "st clair"). */
const keywordForm = (s: string) =>
  cleanKeyword(
    s
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^\p{L}\p{N}\s'-]/gu, " "),
  );

/** Words in a business name that say what it is, not who: "Glowworm Lab" is "glowworm". */
const GENERIC_NAME = new Set(
  (
    "the and of a lab labs agency studio studios co company inc llc ltd group web design designs digital media creative " +
    "marketing solutions services service consulting partners works com net org io"
  ).split(" "),
);

/** A name without its generic words, squashed: "Glowworm Lab" → "glowworm". */
const nameCore = (name: string) =>
  name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !GENERIC_NAME.has(w))
    .join("");

/** A domain label without generic words at its end: "glowwormlab" → "glowworm", "betaweb" → "beta". */
function labelCore(label: string): string {
  let core = label;
  for (let changed = true; changed; ) {
    changed = false;
    for (const w of GENERIC_NAME) {
      if (w.length >= 3 && core.length - w.length >= 4 && core.endsWith(w)) {
        core = core.slice(0, -w.length);
        changed = true;
      }
    }
  }
  return core;
}

const labelOf = (domain: string) => domain.toLowerCase().replace(/^www\./, "").split(".")[0];

/** The towns the homepage names: those it serves, then the business's own. */
const townsOf = (site: SiteFacts | null) => {
  const all = site ? [...site.cities, ...(site.business ? [site.business.city] : [])] : [];
  return all.filter((c, i) => all.findIndex((d) => townOf(d).toLowerCase() === townOf(c).toLowerCase()) === i);
};

/** The page's title and description with every spelling of the brand's full name taken out ("Glowworm Lab", "glowwormlab"). */
function textWithoutBrand(site: SiteFacts, fullNames: string[]): string {
  let text = [site.title, site.description].filter(Boolean).join(" ").toLowerCase();
  for (const name of fullNames) if (name.length >= 3) text = text.replace(new RegExp(name.split("").map(escape).join("[\\s.\\-_']*"), "g"), " ");
  return text;
}

/**
 * The brand's spellings, squashed: the project's name, the domain's first label and the business's
 * name, plus each one's distinctive part when the homepage was read ("glowworm" for Glowworm
 * Lab, so "glow worm agency" and glowworm-co.example count as the brand). The distinctive part is
 * left out when the page's title or description uses it apart from the name, as "Salem Web
 * Design" does with Salem, or when it names a town the business serves.
 */
export function brandTokens(projectName: string, domain: string, site: SiteFacts | null = null): string[] {
  const label = labelOf(domain);
  const names = [projectName, site?.business?.name ?? ""].filter(Boolean);
  const full = [...names.map(squash), squash(label)];
  const cores: string[] = [];
  if (site) {
    const towns = townsOf(site).map((c) => squash(townOf(c)));
    const text = squash(textWithoutBrand(site, full));
    for (const core of [...names.map(nameCore), labelCore(label)]) {
      const isTown = towns.some((t) => t && (core.includes(t) || t.includes(core)));
      if (core.length >= 4 && !isTown && !text.includes(core)) cores.push(core);
    }
  }
  return [...new Set([...full, ...cores])].filter((t) => t.length >= 3);
}

/** A keyword that names the brand: tracked as rank, but no use as an AI visibility question. */
export const isBranded = (keyword: string, brand: string[]) => brand.some((b) => squash(keyword).includes(b));

/** Edit distance between two short names. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/**
 * A domain named like the brand, or nearly (glowworm-co.example and glowwoorm.example for Glowworm
 * Lab): a namesake that shares brand searches, not a competitor.
 */
export function isLookalike(domain: string, brand: string[]): boolean {
  const labels = domain.toLowerCase().replace(/^www\./, "").split(".").slice(0, -1).map(squash).filter((l) => l.length >= 4);
  return labels.some((l) =>
    brand.some((b) => (b.length >= 4 && l.includes(b)) || (l.length >= 5 && b.includes(l)) || (b.length >= 6 && Math.abs(l.length - b.length) <= 2 && distance(l, b) <= 2)),
  );
}

/** Business-type words at the end of a service: "web design agency" is "web design" sold by an agency. */
const PROVIDER = / (agency|company|firm|studio|services?|experts?|specialists?|team|pros?)$/;

/** Searches made from the homepage, at most. */
const MAX_SEEDS = 12;

/** Selling words at the start of a title: they aren't part of what people search for. */
const MARKETING = /^(?:the )?(?:best|top|leading|premier|affordable|trusted)\s+/;

/** A price in a title, with the words around it: "From $400/mo", "starting at $99", "$3,500 one-time", "400/mo". Nobody searches for it. */
const PRICE =
  /(?:\b(?:from|starting (?:at|from)|starts (?:at|from)|only|just|under|as low as|for)\s+)?(?:[$£€]\s?\d[\d,.]*(?:\s?(?:\/\s?|(?:a|an|per)\s+)(?:mo|mth|month|yr|year|wk|week|hr|hour)\b|\s+one[- ]time\b)?|\b\d[\d,.]*\s?\/\s?(?:mo|mth|month|yr|year|wk|week|hr|hour)\b)/gi;

/** Words after a town that make it an area: "Riverton Bay" is around Riverton. */
const AREA = "(?: (?:bay|area|metro|region))?";

/** A title segment with its towns, states and selling words out: "best hr consultant riverton bay tx" → "hr consultant". */
function serviceIn(segment: string, places: { town: string; region: string }[]): string {
  let service = segment.replace(MARKETING, "");
  for (const { town, region } of places) {
    const abbr = regionAbbr(region);
    const state = [region, abbr].filter(Boolean).map((r) => escape(r!)).join("|");
    if (town) service = service.replace(new RegExp(`(^| )${escape(town)}${AREA}${state ? `(?: (?:${state}))?` : ""}(?= |$)`), " ");
  }
  return cleanKeyword(service)
    .replace(/^(in|near|of|for|the) /, "")
    .replace(/ (in|near|of|for)$/, "");
}

/** "human resources consultant" as "hr consultant", when the site itself says "HR". */
function shortForm(phrase: string, site: SiteFacts): string | null {
  const said = new Set(`${site.title ?? ""} ${site.description ?? ""}`.match(/\b[A-Z]{2,5}\b/g) ?? []);
  const words = phrase.split(" ");
  for (let n = Math.min(words.length, 4); n >= 2; n--) {
    const initials = words.slice(0, n).map((w) => w[0]).join("");
    if (said.has(initials.toUpperCase())) return [initials, ...words.slice(n)].join(" ");
  }
  return null;
}

const placesOf = (site: SiteFacts | null) => townsOf(site).map((c) => ({ town: keywordForm(townOf(c)), region: keywordForm(c.split(",")[1] ?? "") }));

/**
 * What the homepage says the business sells, as people search for it, most searched form first:
 * the title's service, then what the description says it offers. `phrase` is the title's own
 * wording when that already reads as a search.
 */
function searchTerms(site: SiteFacts | null, brand: string[]): { phrase: string | null; terms: string[] } {
  const places = placesOf(site);
  if (!site?.title || !places.length) return { phrase: null, terms: [] };
  const segment = site.title
    .split(/\s+[|–—:·•-]\s+/)
    .map((s) => keywordForm(s.replace(PRICE, " ")))
    .find((s) => {
      const service = s && !isBranded(s, brand) ? serviceIn(s, places) : "";
      return service && service.split(" ").length <= 6;
    });
  if (!segment) return { phrase: null, terms: [] };
  const service = serviceIn(segment, places);
  const core = service.replace(PROVIDER, "");
  // "hr consultant services" isn't a search, while "web design agency" and "web design" both are.
  const sellsAPerson = PERSON.test(core.split(" ").pop()!) && / services?$/.test(service);
  const offer = site.offer && !isBranded(site.offer, brand) ? keywordForm(site.offer) : null;
  const short = shortForm(core, site);
  const terms = [short, core, sellsAPerson ? null : service, offer].filter((t): t is string => !!t);
  const isOwnWording = segment !== service && !MARKETING.test(segment) && !/\b(bay|area|metro|region)\b/.test(segment.replace(service, ""));
  return { phrase: isOwnWording ? segment : null, terms: [...new Set(terms)] };
}

/**
 * Searches the homepage says a local business wants to be found for: the title's phrase when it
 * names a town ("st clair web design agency"), then the service in each town the business
 * serves ("web design riverton", "web design agency riverton"). None for a site that names no town: its
 * title is a slogan as often as a search.
 */
export function homepageSeeds(site: SiteFacts | null, brand: string[]): string[] {
  const { phrase, terms } = searchTerms(site, brand);
  const seeds = phrase ? [phrase] : [];
  for (const { town } of placesOf(site)) if (town) for (const term of terms) seeds.push(`${term} ${town}`);
  return [...new Set(seeds)].filter((s) => !isBranded(s, brand)).slice(0, MAX_SEEDS);
}

/** The towns a local business's competitors are looked up in, at most. */
const MAX_MAPS_TOWNS = 3;

/** The Google Maps searches that find a local business's competitors: its main service in each of its main towns. */
export function mapsKeywords(input: Pick<SetupInput, "domain" | "projectName" | "site">): string[] {
  const brand = brandTokens(input.projectName, input.domain, input.site);
  const term = searchTerms(input.site, brand).terms[0];
  return term ? townsOf(input.site).slice(0, MAX_MAPS_TOWNS).map((town) => `${term} ${town}`) : [];
}

/** Words that say nothing about what a business does. */
const FILLER = new Set(
  (
    "a an the and or of for to in on at by with from as is are be that this these our your you we us it its one all more " +
    "most get gets got found make makes help helps build builds building built new best top good great near me site sites page day"
  ).split(" "),
);

/** Words too broad to say a keyword is about this business on their own. */
const BROAD = new Set("service services business businesses small company companies professional solutions consulting consultant".split(" "));

/** A phrase's words, with "e-commerce" also as "ecommerce". */
const wordsOf = (s: string) =>
  keywordForm(s)
    .split(" ")
    .flatMap((w) => (w.includes("-") ? [w, w.replace(/-/g, "")] : [w]))
    .filter((w) => w.length > 1 && !/^\d+$/.test(w));

/** Words in a question, which say nothing about its subject. */
const ASKING = new Set("how what why when where who which can does do should will".split(" "));

/** Selling and scheduling words at the start of a title: "Daily Basecamp reports" is searched as "basecamp report". */
const TITLE_OPENER = /^(?:(?:the|a|an|best|top|leading|premier|affordable|trusted|simple|easy|fast|daily|weekly|monthly|automatic|automated|online|modern|smart|powerful|better|free) )+/;

/** Where a title stops naming the product and starts describing it: "basecamp reports that tell you what changed". */
const TITLE_CLAUSE = / (?:that|which|who|to|with|for|so|and|in|on|your|you|without|by|from)\b.*$/;

/** A plural's singular, the form most software is searched by: "reports" → "report". */
const singular = (phrase: string) => phrase.replace(/(?<=\p{L}{2}[^siu\s])s$/u, "");

/** The product a title names, as a search: "Daily Basecamp reports that tell you what changed" → "basecamp report". */
function titleSearch(site: SiteFacts, brand: string[], type: BusinessType): string | null {
  for (const part of (site.title ?? "").split(/\s+[|–—:·•-]\s+/)) {
    const clause = keywordForm(part).replace(TITLE_CLAUSE, "").replace(TITLE_OPENER, "");
    const words = clause.split(" ").length;
    if (clause && !isBranded(clause, brand) && words >= 2 && words <= 4) return type === "store" ? clause : singular(clause);
  }
  return null;
}

/**
 * A first guess at what people search for to find a business that isn't local, free, for the user to
 * correct: the product the title names, what the description offers, the homepage's guides on the
 * same subject. A title is a slogan as often as a search, which is why the user sees these before
 * anything is spent.
 */
export function suggestedSearches(input: { site: SiteFacts | null; domain: string; projectName: string; type: BusinessType; topics?: string[] }): string[] {
  const { site } = input;
  const brand = brandTokens(input.projectName, input.domain, site);
  const title = site && titleSearch(site, brand, input.type);
  const offer = site?.offer ? keywordForm(site.offer) : null;
  const main = [title, offer].filter((s): s is string => !!s);
  const mainWords = new Set(main.flatMap(wordsOf).filter((w) => !FILLER.has(w)));
  const isSubject = (topic: string) => {
    const words = wordsOf(topic);
    return words.length >= 2 && words.length <= 4 && !ASKING.has(words[0]) && (!mainWords.size || words.some((w) => mainWords.has(w) || mainWords.has(singular(w))));
  };
  // The shortest first: a guide on "recover deleted basecamp messages" is about a task, one on "basecamp snapshots" about a subject.
  const topics = (input.topics ?? []).filter(isSubject).sort((a, b) => wordsOf(a).length - wordsOf(b).length);
  const all = [...main, ...topics];
  return [...new Set(all)].filter((s) => s.length >= 2 && !isBranded(s, brand)).slice(0, MAX_SEARCHES);
}

/** Whether two words are the same word in different forms: "report" and "reporting", "web" and "website". */
const sameWord = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)));

/** What a search is about, without its question and filler words. */
const subjectWords = (search: string) => wordsOf(search).filter((w) => w.length >= 3 && !FILLER.has(w) && !BROAD.has(w) && !ASKING.has(w));

/**
 * Words the page capitalises in the middle of a sentence, lower case: the names of products and
 * companies ("Basecamp" in "Daily Basecamp reports that tell you what changed"). A line in title
 * case says nothing, since every word in it has a capital.
 */
function properNames(site: SiteFacts | null): Set<string> {
  const out = new Set<string>();
  for (const line of site ? [site.title, site.description, ...site.headings] : []) {
    const words = (line ?? "").split(/\s+/);
    if (!words.some((w) => /^[a-z]{3,}/.test(w))) continue;
    words.forEach((word, i) => {
      const name = word.match(/^([A-Z][\p{Ll}\p{N}]+)[,.;:!?)]*$/u)?.[1];
      if (name && i > 0 && !/[.!?:]$/.test(words[i - 1])) out.add(name.toLowerCase());
    });
  }
  return out;
}

/**
 * The words a keyword has to contain to be about this business, from the searches Google knows: the
 * name of a product the business is built on ("basecamp" for a Basecamp report), else a word all
 * those searches share. None when neither shows: most businesses aren't built on another product,
 * and the homepage's vocabulary decides as before.
 */
function anchorWords(searches: SetupSearch[], site: SiteFacts | null): string[] {
  const lists = searches.filter((s) => s.ideas.length).map((s) => subjectWords(s.keyword));
  const names = properNames(site);
  const named = [...new Set(lists.flat().filter((w) => names.has(w)))];
  if (named.length || lists.length < 2) return named;
  return lists[0].filter((w) => lists.every((l) => l.some((v) => sameWord(v, w))));
}

/** A site with its own section of a forum, or a help site: where people ask about a product, not a rival to it. */
const FORUM_LABEL = /^(?:community|forums?|support|help|docs|answers|.+forums?)$/;

const isForum = (domain: string) => domain.split(".").slice(0, -1).some((l) => FORUM_LABEL.test(l));

/** A domain's name, past its subdomains and country ending: "blog.syncpail.io" is "syncpail", "shop.acme.co.uk" is "acme". */
function siteName(domain: string): string {
  const labels = bareDomain(domain).split(".");
  if (labels.length < 2) return labels[0];
  const last = labels.length - 2;
  return labels[last].length <= 3 && labels.length > 2 ? labels[last - 1] : labels[last];
}

/** What the proposal knows about the business beyond the keyword lists. */
interface Context {
  brand: string[];
  /** Words a keyword has to contain to be about this business, when the searches show any. */
  anchors: string[];
  /** Towns it serves, "Riverton, Ohio" style, for local questions. */
  places: string[];
  seeds: string[];
  /** Whether a keyword is about what the homepage says the business does: two of its words, or one that isn't broad. Always true when the page wasn't read. */
  onTopic: (keyword: string) => boolean;
  /** The words the title and description use for themselves, to tell a site about jobs from a site that shows up for them. */
  saysItself: (word: string) => boolean;
  /** Capitals as the site writes them, so a question reads "HR consultant". */
  styled: (text: string) => string;
}

function context(input: Pick<SetupInput, "domain" | "projectName" | "site" | "searches">): Context {
  const { site } = input;
  const searches = input.searches ?? [];
  const brand = brandTokens(input.projectName, input.domain, site);
  const places = townsOf(site);
  const towns = new Set(places.flatMap((c) => wordsOf(townOf(c))));
  const fullNames = [squash(input.projectName), squash(labelOf(input.domain)), ...(site?.business ? [squash(site.business.name)] : [])];
  const pageText = site ? `${textWithoutBrand(site, fullNames)} ${(site.services ?? []).join(" ")}` : "";
  // The user's own searches say what the business does as surely as its homepage.
  const vocabulary = new Set(wordsOf(`${pageText} ${searches.map((s) => s.keyword).join(" ")}`).filter((w) => !FILLER.has(w) && !towns.has(w) && !isBranded(w, brand)));
  const anchors = anchorWords(searches, site);
  const known = (w: string) => vocabulary.has(w) || [...vocabulary].some((v) => v.length >= 3 && w.length >= 3 && (w.startsWith(v) || v.startsWith(w)));
  const capitals = [...new Set(`${site?.title ?? ""} ${site?.description ?? ""}`.match(/\b[A-Z]{2,5}\b/g) ?? [])];
  const names = [...properNames(site)].filter((n) => anchors.includes(n));
  return {
    brand,
    anchors,
    places,
    seeds: homepageSeeds(site, brand),
    onTopic: (keyword) => {
      if (searches.some((s) => s.keyword === keyword)) return true;
      if (anchors.length) return wordsOf(keyword).some((w) => anchors.some((a) => sameWord(w, a)));
      if (!vocabulary.size) return true;
      const hits = wordsOf(keyword).filter(known);
      return hits.length >= 2 || hits.some((w) => !BROAD.has(w));
    },
    saysItself: (word) => wordsOf(pageText).includes(word),
    styled: (text) => {
      const named = names.reduce((t, n) => t.replace(new RegExp(`\\b${escape(n)}\\b`, "g"), `${n[0].toUpperCase()}${n.slice(1)}`), text);
      return capitals.reduce((t, c) => t.replace(new RegExp(`\\b${c}\\b`, "gi"), c), named);
    },
  };
}

/**
 * The searches whose Google results name the competitors: the homepage's services in its towns and
 * the searches the user named, then the unbranded, on-topic keywords Google knows that contain them,
 * what it ranks for (by volume) and Google's ideas for it. Brand
 * searches are left out, since the sites in them share a name, not a business. The same input always
 * gives the same list, so the lookup is cached and quoted like the others.
 */
export function competitorQueries(input: Pick<SetupInput, "domain" | "projectName" | "site" | "keywords" | "ideas" | "searches">): string[] {
  const { brand, seeds, onTopic } = context(input);
  const searches = input.searches ?? [];
  const out = new Set([...seeds, ...searches.map((s) => s.keyword)]);
  for (const k of [...searchIdeas(searches), ...[...input.keywords].sort((a, b) => b.volume - a.volume), ...input.ideas]) {
    const keyword = cleanKeyword(k.keyword);
    if (keyword && !isBranded(keyword, brand) && onTopic(keyword)) out.add(keyword);
  }
  return [...out].slice(0, MAX_COMPETITOR_QUERIES);
}

/** Every keyword Google knows that contains one of the searches, once, most searched first. */
function searchIdeas(searches: SetupSearch[]): { keyword: string; volume: number }[] {
  const out = new Map<string, number>();
  for (const k of searches.flatMap((s) => s.ideas)) out.set(cleanKeyword(k.keyword), k.volume);
  return [...out].map(([keyword, volume]) => ({ keyword, volume })).sort((a, b) => b.volume - a.volume);
}

const ownSite = (d: string, own: string) => d === own || d.endsWith(`.${own}`) || own.endsWith(`.${d}`);

function competitorReason(shared: number, checked: number): string {
  if (checked <= 1) return "Ranks in Google for the search checked";
  return `Ranks in Google for ${shared === checked ? "all" : shared} of ${checked} searches for your business`;
}

const bareDomain = (d: string) => d.toLowerCase().replace(/^www\./, "");

/** The Maps category most of a search's businesses share, when one stands out: "Human resource consulting", not the tax office Google added for "HR". */
function mainCategory(items: MapsSearch["items"]): string | null {
  const counts = new Map<string, number>();
  for (const item of items) for (const c of new Set([item.category, ...item.categories])) if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  const [top] = [...counts].sort((a, b) => b[1] - a[1]);
  return top && top[1] >= 3 && top[1] >= items.length / 4 ? top[0] : null;
}

/**
 * A local business's competitors: the websites of the businesses Google Maps shows for its service
 * in its towns, the main town's best first, then taking turns so one town doesn't fill the list.
 * Businesses in another line of work and listings without a website are left out.
 */
/** The name to carry, if any. A longer title is keyword stuffing, and over the limit it would fail the whole Apply. */
function competitorName(title: string | null | undefined): { name: string } | Record<string, never> {
  const name = title?.trim();
  return name && name.length >= 2 && name.length <= MAX_COMPETITOR_NAME ? { name } : {};
}

function localRivals(input: SetupInput, keep: (domain: string) => boolean): ProposedCompetitor[] {
  const searches = input.maps ?? [];
  const category = mainCategory(searches.flatMap((s) => s.items.filter((i) => i.domain)));
  const lists = searches.map((s) => ({
    keyword: s.keyword,
    items: s.items
      .map((item, i) => ({ ...item, rank: i + 1, domain: item.domain ? bareDomain(item.domain) : null }))
      .filter((item): item is typeof item & { domain: string } => !!item.domain && keep(item.domain) && (!category || item.category === category || item.categories.includes(category))),
  }));
  const out: ProposedCompetitor[] = [];
  for (let turn = 0; out.length < PROPOSAL_LIMITS.competitors; turn++) {
    if (lists.every((l) => turn >= l.items.length)) break;
    for (const l of lists) {
      const item = l.items[turn];
      if (item && out.length < PROPOSAL_LIMITS.competitors && !out.some((c) => c.domain === item.domain)) {
        out.push({ domain: item.domain, reason: `#${item.rank} on Google Maps for “${l.keyword}”`, ...competitorName(item.title) });
      }
    }
  }
  return out;
}

/** Someone looking for work, not for the business: never what a business wants to be found for, unless that's what it says it does. */
const JOB_SEEKING = /^(careers?|jobs?|salary|salaries|internships?)$/;
/** Someone studying the subject rather than choosing who to pay. */
const STUDYING = /^(courses?|certifications?|certificates?|degrees?|definition|meaning|wiki|pdf)$/;
/** Someone reading about the subject: fine for software, which people compare, not for a local firm. */
const READING = /^(reviews?|templates?|examples?|samples?|how|what|why)$/;

const NEAR_ME = /\bnear me\b/;
/** Words that say someone is looking for a provider. */
const LOCAL_PROVIDER = /\b(near me|consultants?|consulting|consultancy|services?|compan(y|ies)|firms?|agenc(y|ies)|contractors?|providers?|specialists?|experts?|outsourcing)\b/;
/** Words that say someone is choosing software. */
const SOFTWARE_WORDS = /\b(software|tools?|apps?|platforms?|alternatives?|vs|pricing|compare|comparison|best|top)\b/;
/** Words that say someone means to buy something. */
const STORE_WORDS = /\b(buy|shop|stores?|price|prices|cheap|sale|best|online)\b/;

/** The question a shopper asks. Most keywords a store ranks for are products. */
const storeQuestion = (keyword: string) => `Where can I buy ${keyword} online?`;

/**
 * What makes two keywords the same question: the same words in any order ("basecamp report", "report
 * basecamp"), or the same first three content words ("human resources performance" review, appraisal,
 * goals). A question word counts, since "how to report basecamp" asks something "basecamp report" doesn't.
 */
const questionKeys = (keyword: string): string[] => {
  const words = wordsOf(keyword).filter((w) => !FILLER.has(w));
  // Numbers count here, though `wordsOf` drops them: "iphone 15 case" isn't "iphone 16 case".
  const all = keywordForm(keyword).split(" ").filter((w) => !FILLER.has(w));
  const sameWords = `any order: ${[...new Set(all.map(singular))].sort().join(" ")}`;
  return words.length >= 3 ? [words.slice(0, 3).join(" "), sameWords] : [sameWords];
};

/** Words a keyword can start with and still read as a question: "best basecamp report", "how to report basecamp". */
const QUESTION_OPENER = new Set(["best", "top", "free", ...ASKING]);

/**
 * The questions a local business wants AI assistants to answer with its name, none of which depend
 * on Google's keyword lists: its service in each town, then what it does and who it does it for, in
 * turn, so the list covers its services and its towns rather than rewording one question.
 */
function localQuestions(site: SiteFacts | null, brand: string[], places: string[]): { prompt: string; keyword: string }[] {
  const { terms } = searchTerms(site, brand);
  const towns = places.map((p) => ({ place: p, town: keywordForm(townOf(p)) }));
  if (!towns.length) return [];
  const services = site?.services ?? [];
  const audiences = site?.audiences ?? [];
  const main = terms[0];
  const inTown = (term: string, t: (typeof towns)[number]) => keywordToPrompt(`${term} ${t.town}`, [t.place]);
  const out: { prompt: string; keyword: string }[] = main ? towns.map((t) => ({ prompt: inTown(main, t), keyword: `${main} ${t.town}` })) : [];
  const rounds = Math.max(services.length, audiences.length);
  for (let i = 0; i < rounds; i++) {
    const t = towns[(i + (main ? 1 : 0)) % towns.length];
    const who = audiences.length ? audiences[i % audiences.length] : null;
    if (services[i]) {
      out.push({
        prompt: who ? `Who helps ${who} with ${services[i]} in ${t.place}?` : `Who can help with ${services[i]} in ${t.place}?`,
        keyword: `${services[i]} ${t.town}`,
      });
    }
    if (main && audiences[i]) {
      out.push({ prompt: inTown(main, t).replace(` in ${t.place}?`, ` for ${audiences[i]} in ${t.place}?`), keyword: `${main} for ${audiences[i]} ${t.town}` });
    }
  }
  return out;
}

export function plainProposal(input: SetupInput): Proposal {
  const notes: string[] = [];
  const own = input.domain.toLowerCase();
  const type = input.type ?? "other";
  const { brand, anchors, places, seeds, onTopic, saysItself, styled } = context(input);
  const searches = input.searches ?? [];
  const checked = competitorQueries(input).length;
  const townWords = places.map((p) => keywordForm(townOf(p)));
  const named = (k: string) => townWords.some((t) => ` ${k} `.includes(` ${t} `));

  const notForBusiness = (k: string) => {
    const pattern = (w: string) => JOB_SEEKING.test(w) || (type !== "other" && STUDYING.test(w)) || (type === "local" && READING.test(w));
    return wordsOf(k).some((w) => pattern(w) && !saysItself(w));
  };
  /** Whether a keyword is what this kind of business wants to be found for. */
  const fits = (k: string) => (type === "local" ? named(k) || LOCAL_PROVIDER.test(k) : true) && !notForBusiness(k);
  /** Keywords that say someone is choosing, first: a software company wants "x alternatives" more than a broader search with more volume. */
  const intent = (k: string) => {
    if (type === "software") return SOFTWARE_WORDS.test(k) ? 0 : 1;
    if (type === "store") return STORE_WORDS.test(k) ? 0 : 1;
    return 0;
  };

  const tracked = new Set(input.existing.competitors.map((d) => d.toLowerCase()));
  const keepRival = (domain: string) => !ownSite(domain, own) && !isPlatformSite(domain) && !isLookalike(domain, brand) && !tracked.has(domain);
  // Whatever the business is built on isn't its rival, and nor is a forum about it: community.basecamp.com for a Basecamp report.
  const keepSite = (domain: string) => keepRival(domain) && !isForum(domain) && !anchors.includes(siteName(domain));
  const compared = [...new Set((input.comparedSites ?? []).map(bareDomain))].filter(keepSite);
  const competitors =
    type === "local"
      ? localRivals(input, keepRival)
      : [
          ...compared.map((domain) => ({ domain, reason: "Named on your comparison page" })),
          ...input.competitors
            .map((c) => ({ ...c, domain: bareDomain(c.domain) }))
            .filter((c) => keepSite(c.domain) && !compared.includes(c.domain))
            .sort((a, b) => b.keywords - a.keywords)
            .map((c) => ({ domain: c.domain, reason: competitorReason(c.keywords, checked) })),
        ].slice(0, PROPOSAL_LIMITS.competitors);
  if (type === "local") {
    if (!competitors.length && !tracked.size) notes.push("Google Maps showed no businesses like this one in its towns, so add the competitors you know.");
    if (input.unknownTowns?.length) notes.push(`Couldn't find ${input.unknownTowns.join(", ")} in Google's list of towns, so its Google Maps results aren't included. Check the spelling, or use the town's full name.`);
  } else if (!competitors.length && !tracked.size) {
    notes.push(checked ? "Google's results for these searches showed no other businesses like this one, so add the ones you know in Project settings." : "No searches to check for competitors yet. Name what people search for to find you and make a new proposal, or add the competitors you know in Project settings.");
  }

  const have = new Set(input.existing.keywords.map((k) => k.toLowerCase()));
  const ranked: { keyword: string; volume: number }[] = [];
  for (const k of [...input.keywords].sort((a, b) => b.volume - a.volume)) {
    const keyword = cleanKeyword(k.keyword);
    if (!keyword || have.has(keyword) || ranked.some((r) => r.keyword === keyword)) continue;
    ranked.push({ keyword, volume: k.volume });
  }
  // On-topic keywords first, then the rest, then a few brand searches: namesakes ("glowworm" the
  // word, for Glowworm Lab) otherwise fill the list. A local business only keeps those about
  // its services: a ranking for a national search it can't serve isn't worth a daily check.
  const group = (k: string) => (isBranded(k, brand) ? 2 : onTopic(k) ? 0 : 1);
  let brandedLeft = MAX_BRANDED_KEYWORDS;
  const wanted = ranked.filter((k) => isBranded(k.keyword, brand) || (fits(k.keyword) && (type !== "local" || onTopic(k.keyword))));
  const offTopic = ranked.length - wanted.length;
  if (offTopic > 0 && type === "local") notes.push(`Left out ${plural(offTopic, "keyword")} you rank for that ${offTopic === 1 ? "isn't" : "aren't"} about your services or towns.`);
  const trackable = [...wanted].sort((a, b) => group(a.keyword) - group(b.keyword) || intent(a.keyword) - intent(b.keyword)).filter((k) => group(k.keyword) < 2 || brandedLeft-- > 0);
  const keywordCap = Math.min(PROPOSAL_LIMITS.keywords, input.room.keywords);
  const pickedKeywords = trackable.slice(0, keywordCap);
  const tags = suggestTopics(pickedKeywords.map((k) => k.keyword));
  const keywords = pickedKeywords.map((k, i) => ({ ...k, tag: isBranded(k.keyword, brand) ? "brand" : tags[i] }));

  // Ideas leave out everything the site ranks for, picked or not: those aren't new. The homepage's
  // own searches come first; Google's ideas follow when they're about the business.
  const known = new Set([...have, ...ranked.map((k) => k.keyword)]);
  const volumes = new Map([...input.ideas, ...searches.flatMap((s) => s.ideas), ...(input.seedVolumes ?? [])].map((k) => [cleanKeyword(k.keyword), k.volume]));
  // A local business only gets Google's ideas that name its towns or say "near me". The rest are
  // about the subject, not about hiring someone there ("becoming a human resources consultant").
  const fromSearches = new Set(searchIdeas(searches).map((k) => k.keyword));
  const googleRows = [...searchIdeas(searches), ...input.ideas].map((k) => ({ keyword: cleanKeyword(k.keyword), volume: k.volume }));
  const placed = (k: string) => named(k) || NEAR_ME.test(k);
  const googleIdeas = googleRows
    .filter((k) => fits(k.keyword) && (type !== "local" || placed(k.keyword)))
    // Google's order within each: for a local business its towns first, otherwise what shows intent.
    .map((k, i) => ({ k, i, rank: type === "local" ? (named(k.keyword) ? 0 : 1) : intent(k.keyword) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ k }) => k);
  const elsewhere = googleRows.filter((k) => !placed(k.keyword)).length;
  if (type === "local" && elsewhere > 0) notes.push(`Left out ${plural(elsewhere, "keyword idea")} from Google that ${elsewhere === 1 ? "doesn't" : "don't"} name your towns.`);
  const pool: Omit<ProposedKeyword, "tag">[] = [
    ...seeds.map((keyword) => ({ keyword, volume: volumes.get(keyword) ?? null, source: "homepage" as const })),
    ...searches.map(({ keyword, ideas }) => ({ keyword, volume: volumes.get(keyword) ?? null, source: ideas.length ? ("search" as const) : ("unknown" as const) })),
    ...googleIdeas.map((k) => (fromSearches.has(k.keyword) ? { ...k, source: "search" as const } : k)),
  ];
  const newIdeas: Omit<ProposedKeyword, "tag">[] = [];
  const abroad = new Set<string>();
  for (const k of pool) {
    if (newIdeas.length >= Math.min(PROPOSAL_LIMITS.ideas, input.room.keywords)) break;
    if (!k.keyword || known.has(k.keyword) || newIdeas.some((i) => i.keyword === k.keyword)) continue;
    if (isBranded(k.keyword, brand) || !onTopic(k.keyword)) continue;
    // Google's ideas can name somewhere the business doesn't serve ("website seo london" for a
    // Salem designer). Place names in its own country, and its own towns, stay.
    const place = k.source === "homepage" || k.source === "search" ? null : foreignPlace(k.keyword, input.locationCode, places);
    if (place) {
      abroad.add(place);
      continue;
    }
    newIdeas.push(k);
  }
  if (abroad.size) {
    const named = [...abroad].slice(0, 3).join(", ");
    notes.push(`Left out keyword ideas naming places outside ${locationName(input.locationCode ?? 0)} (${named}${abroad.size > 3 ? " and others" : ""}).`);
  }
  const unknown = searches.filter((s) => !s.ideas.length).map((s) => `“${s.keyword}”`);
  if (unknown.length) {
    const named = new Intl.ListFormat("en", { type: "conjunction" }).format(unknown);
    const it = unknown.length === 1 ? "it" : "them";
    notes.push(`Google has no data for ${named}, so ${unknown.length === 1 ? "it" : "they"} didn't shape this proposal and ${unknown.length === 1 ? "starts" : "start"} unticked. Check the wording if people do search for ${it}.`);
  }
  const reported = searchIdeas(searches);
  const monthly = reported.reduce((sum, k) => sum + k.volume, 0);
  if (reported.length && monthly < SMALL_MARKET_SEARCHES) {
    notes.push(`This is a small market: Google reports about ${formatNumber(monthly)} searches a month across the ${plural(reported.length, "keyword")} it knows for your searches. Expect small numbers in Rankings.`);
  }
  const ideaTags = suggestTopics(newIdeas.map((k) => k.keyword));
  const ideas = newIdeas.map((k, i) => ({ ...k, tag: ideaTags[i] }));

  if (!input.keywords.length)
    notes.push(ideas.length ? "The site doesn't rank for keywords Google reports yet. Pick from the keyword ideas, or add your own." : "The site doesn't rank for keywords Google reports yet, so add the ones you want to track.");
  else if (trackable.length > keywordCap) notes.push(input.room.keywords < PROPOSAL_LIMITS.keywords ? `Your plan has room for ${plural(input.room.keywords, "more keyword")}.` : `The top ${keywordCap} by search volume.`);

  const asked = new Set(input.existing.prompts.map((p) => p.toLowerCase()));
  const promptCap = Math.min(PROPOSAL_LIMITS.prompts, input.room.prompts);
  const candidates: { prompt: string; keyword: string }[] = [];
  const usedKeys = new Set<string>();
  const addQuestion = (prompt: string, keyword: string) => {
    if (!prompt || candidates.length >= promptCap || asked.has(prompt.toLowerCase()) || candidates.some((c) => c.prompt.toLowerCase() === prompt.toLowerCase())) return;
    candidates.push({ prompt: styled(prompt), keyword });
  };
  if (type === "local") for (const q of localQuestions(input.site, brand, places)) addQuestion(q.prompt, q.keyword);
  // Software gets compared with its rivals by name: the domains are real, from Google's results.
  const alternatives = type === "software" ? competitors.slice(0, 2).map((c) => siteName(c.domain)).filter((l) => l.length >= 3) : [];
  const roomForKeywords = promptCap - alternatives.length;
  // The homepage's searches and the user's first, then ranked keywords, then ideas, so a site that
  // ranks for little still gets questions about what it sells. Keywords that reword one another make one question.
  const asks = [...seeds.map((keyword) => ({ keyword })), ...searches.filter((s) => s.ideas.length).map(({ keyword }) => ({ keyword })), ...wanted, ...newIdeas.filter((k) => k.source !== "unknown")];
  // Keywords that lead with the product read better as questions than those that bury it: "basecamp report project", not "report basecamp project".
  const buried = (k: string) => {
    const first = wordsOf(k)[0];
    return anchors.length && first && !QUESTION_OPENER.has(first) && !anchors.some((a) => sameWord(first, a)) ? 1 : 0;
  };
  for (const k of [...asks].map((k, i) => ({ k, i })).sort((a, b) => intent(a.k.keyword) - intent(b.k.keyword) || buried(a.k.keyword) - buried(b.k.keyword) || a.i - b.i).map(({ k }) => k)) {
    if (candidates.length >= roomForKeywords) break;
    if (isBranded(k.keyword, brand) || !onTopic(k.keyword)) continue;
    const keys = named(k.keyword) ? [] : questionKeys(k.keyword);
    if (keys.some((key) => usedKeys.has(key))) continue;
    const before = candidates.length;
    // A store's questions alternate: where to buy it, then which is best.
    addQuestion(type === "store" && candidates.length % 2 === 0 ? storeQuestion(k.keyword) : keywordToPrompt(k.keyword, places), k.keyword);
    if (candidates.length > before) for (const key of keys) usedKeys.add(key);
  }
  for (const label of alternatives) addQuestion(`What are the best alternatives to ${label.charAt(0).toUpperCase()}${label.slice(1)}?`, `${label} alternatives`);
  const topics = suggestTopics(candidates.map((c) => c.keyword));
  const prompts = candidates.map((c, i) => ({ ...c, topic: topics[i] }));
  if (input.room.prompts < PROPOSAL_LIMITS.prompts && input.room.prompts <= candidates.length) notes.push(`Your plan has room for ${plural(input.room.prompts, "more AI prompt")}.`);

  return {
    competitors,
    trackedCompetitors: [...tracked],
    keywords,
    ideas,
    keywordRoom: input.room.keywords,
    rankedKeywords: input.keywords.length,
    prompts,
    local: input.site?.business ?? null,
    notes,
  };
}
