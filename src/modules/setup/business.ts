import { placeKey, regionName, stateNames } from "@/lib/dataforseo/place-names";
import { elements, stripTags } from "@/lib/web/html";

/**
 * What kind of business a site is, and the towns it names.
 * The guided setup asks different questions of Google for each type, so it guesses from the
 * homepage for free and the user confirms before anything is spent. Pure, so a wrong guess costs
 * one click and a test, never a paid call.
 */

export const BUSINESS_TYPES = ["local", "software", "store", "other"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const isBusinessType = (v: unknown): v is BusinessType => BUSINESS_TYPES.includes(v as BusinessType);

export const BUSINESS_LABELS: Record<BusinessType, { label: string; hint: string }> = {
  local: { label: "Local business", hint: "Customers come from particular towns: services, shops, clinics." },
  software: { label: "Software or app", hint: "People sign up or subscribe, wherever they are." },
  store: { label: "Online store", hint: "People buy products on the site and get them shipped." },
  other: { label: "Something else", hint: "A publisher, a national service, or none of these." },
};

export const MAX_TOWNS = 5;

/** The towns typed into the setup's box, one per line, since a town's own name can hold a comma. */
export const parseTowns = (text: string): string[] =>
  [...new Set(text.split("\n").map((t) => t.replace(/\s+/g, " ").trim()))].filter((t) => t.length >= 2 && t.length <= 80).slice(0, MAX_TOWNS);

/** Searches looked up for one proposal, at most: each is its own paid lookup. */
export const MAX_SEARCHES = 3;

/** The searches typed into the setup's box, one per line or separated by commas, as Google's keywords are written. */
export const parseSearches = (text: string): string[] =>
  [...new Set(text.split(/[\n,]/).map((s) => s.toLowerCase().replace(/\s+/g, " ").trim()))].filter((s) => s.length >= 2 && s.length <= 80).slice(0, MAX_SEARCHES);

export interface SetupBusiness {
  type: BusinessType;
  /** Towns it serves, "Riverton, Ohio" style, main town first. Only a local business uses them. */
  towns: string[];
  /** What people search for to find it. Only a business that isn't local uses them. */
  searches: string[];
}

const WORD = "[A-Z][\\p{L}'’-]*\\.?";
const RUN = `${WORD}(?: ${WORD}){0,3}`;
const LIST = new RegExp(`${RUN}(?:, ${RUN})*,? and ${RUN}`, "gu");
const AFTER_WORD = new RegExp(`\\b(?:in|near|serving|throughout|across|around)\\s+(${RUN}(?:, ${RUN})*(?:,? and ${RUN})?)`, "gu");
const STATES = stateNames();
const BEFORE_STATE = new RegExp(`(${RUN}),? (${STATES.join("|")})\\b(?: \\d{5})?`, "gu");
/**
 * The first capital in a run of name characters. A name that fits from a later one fits from this
 * one too, so starting only here finds the same names and reads a long run once, not from each
 * capital in it. The lookbehind is lazy, so it stops at the nearest capital.
 */
const NAME_START = "(?=[A-Z])(?<![A-Z][\\p{L}'’-]*?)";
const ADDRESS = new RegExp(`${NAME_START}(${RUN}),? (${STATES.filter((s) => s.length === 2).join("|")}) \\d{5}`, "gu");
/** The most of one line read for towns. A title or description is far shorter, and the patterns above are for short text. */
const MAX_LINE = 2_000;
/** The most addresses read off one page. */
const MAX_ADDRESSES = 500;
/** Words after a town that make it an area rather than a town: "Riverton Bay" is around Riverton. */
const METRO = /\s+(?:bay|area|metro|region)$/i;

/** One place named in the text: its possible spellings, longest first ("Consultant Services Riverton Bay" … "Riverton"). */
export interface TownNames {
  names: string[];
  /** The state named right after it, when one was. */
  region?: string;
}

const clean = (s: string) => s.replace(/['’]s$/, "").replace(/\.$/, "").trim();
const split = (list: string) => list.split(/,\s*(?:and\s+)?|\s+and\s+/).map(clean).filter(Boolean);

/** A line cut to `MAX_LINE` at a space, so no name is cut in two. */
function shortLine(line: string): string {
  if (line.length <= MAX_LINE) return line;
  const space = line.lastIndexOf(" ", MAX_LINE);
  return line.slice(0, space > 0 ? space : MAX_LINE);
}

/** The endings of a run of capitalised words, longest first, each followed by itself without "Bay" or "Area". */
function endings(run: string): string[] {
  const words = clean(run).split(" ");
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const end = words.slice(i).join(" ");
    out.push(end);
    if (METRO.test(end)) out.push(end.replace(METRO, ""));
  }
  return out;
}

/**
 * Places named in these lines (title, description, headings), in order. Only where the wording
 * says it's a place: a list ("Riverton, St Clair, and Fairview's"), after a word like "in" or
 * "serving", or before a state ("Riverton Bay TX"). A capitalised word alone is a town as often as a
 * word in a heading. `matchTowns` checks them against the country's list of towns.
 */
export function townCandidates(lines: string[]): TownNames[] {
  const out: TownNames[] = [];
  const seen = new Set<string>();
  const add = (names: string[], region?: string) => {
    const key = names.map(placeKey).join("|");
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ names, region });
    }
  };
  for (const line of lines.map(shortLine)) {
    const found: { at: number; names: string[]; region?: string }[] = [];
    for (const m of line.matchAll(BEFORE_STATE)) found.push({ at: m.index, names: endings(m[1]), region: regionName(m[2], "us") });
    for (const m of line.matchAll(LIST)) for (const name of split(m[0])) found.push({ at: m.index + m[0].indexOf(name), names: endings(name) });
    for (const m of line.matchAll(AFTER_WORD)) for (const name of split(m[1])) found.push({ at: m.index + m[0].indexOf(name), names: endings(name) });
    for (const f of found.sort((a, b) => a.at - b.at)) add(f.names, f.region);
  }
  return out;
}

/** Street addresses in a page's text ("Riverton, TX 77550"): the surest sign of where a business is. */
export function addressTowns(text: string): TownNames[] {
  const out: TownNames[] = [];
  for (const m of text.matchAll(ADDRESS)) {
    out.push({ names: endings(m[1]), region: regionName(m[2], "us") });
    if (out.length >= MAX_ADDRESSES) break;
  }
  return out;
}

/** Every spelling worth looking up, for one query against the list of towns. */
export const namesToLookUp = (candidates: TownNames[]) => [...new Set(candidates.flatMap((c) => c.names))];

/**
 * The candidates that are real towns, "St Clair, Texas" style, spelled as the site spells
 * them. When the text names a state, a town has to be in one it names; otherwise a name in several
 * states stays without one, for the user to settle.
 */
export function matchTowns(candidates: TownNames[], places: { name: string }[], max = 5): string[] {
  const rows = new Map<string, { region: string | null }[]>();
  for (const p of places) {
    const [town, ...rest] = p.name.split(",").map((s) => s.trim());
    const key = placeKey(town);
    const same = rows.get(key) ?? [];
    same.push({ region: rest[0] ?? null });
    rows.set(key, same);
  }
  const regions = new Set(candidates.flatMap((c) => (c.region ? [c.region] : [])));
  const out: string[] = [];
  for (const c of candidates) {
    for (const name of c.names) {
      const here = rows.get(placeKey(name));
      if (!here) continue;
      const fit = here.filter((r) => r.region && (c.region ? r.region === c.region : regions.has(r.region)));
      if (regions.size && !fit.length) continue;
      const region = fit[0]?.region ?? (here.length === 1 ? here[0].region : null);
      const town = region ? `${name}, ${region}` : name;
      if (!out.some((t) => placeKey(t.split(",")[0]) === placeKey(name))) out.push(town);
      break;
    }
    if (out.length >= max) break;
  }
  return out;
}

const LINK_TEXT = (html: string) => elements(html, ["a"]).map((e) => stripTags(e.inner).replace(/\s+/g, " ").trim().toLowerCase());

/**
 * Whether a JSON "@type" names one of `types`, as `"@type"\s*:\s*\[?[^\]}]*"(?:types)"` would, in
 * linear time: that regex rescans to the next ] or } from every "@type", so only what follows the
 * first "@type" in each stretch between them is searched, once.
 */
function namesSchemaType(html: string, types: string): boolean {
  const name = new RegExp(`"(?:${types})"`);
  return html.split(/[\]}]/).some((part) => {
    const at = /"@type"\s*:/.exec(part);
    return !!at && name.test(part.slice(at.index + at[0].length));
  });
}

/** Whether a link reads "try … free", as `/try .*free/` would, read once rather than from every "try". */
function triesFree(text: string): boolean {
  const at = text.indexOf("try ");
  return at >= 0 && text.includes("free", at + 4);
}

/**
 * A first guess at the type, from what's on the homepage. The strongest signals are schema.org
 * types; a tie goes to the type that sells online, since a software company with a phone number
 * and an office is more common than a plumber with a pricing page.
 */
export function detectBusinessType(html: string, facts: { hasLocalBusiness: boolean; towns: string[] }): BusinessType {
  const links = LINK_TEXT(html);
  const linked = (re: RegExp) => links.some((t) => re.test(t));
  const schema = (types: string) => namesSchemaType(html, types);

  const local = (facts.hasLocalBusiness ? 3 : 0) + (facts.towns.length ? 2 : 0) + (/href=["']tel:/i.test(html) ? 1 : 0);
  const software =
    (schema("SoftwareApplication|WebApplication|MobileApplication") ? 3 : 0) +
    (linked(/^(pricing|plans|plans (and|&) pricing)$/) ? 1 : 0) +
    (linked(/^(log ?in|sign ?in|sign ?up|get started)$/) ? 1 : 0) +
    (links.some(triesFree) || linked(/free trial|start free|for free/) ? 1 : 0) +
    (linked(/^(api|docs|documentation|integrations)$/) ? 1 : 0);
  const store = (schema("Product|Offer|AggregateOffer") ? 3 : 0) + (linked(/^(cart|basket|checkout|my cart)\b/) ? 2 : 0) + (/cdn\.shopify\.com|woocommerce/i.test(html) ? 2 : 0);

  const best = Math.max(local, software, store);
  if (best < 2) return "other";
  if (store === best) return "store";
  if (software === best) return "software";
  return "local";
}
