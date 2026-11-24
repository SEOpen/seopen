import { decodeEntities, elements, jsonLdBlocks, openTags, pageFacts, stripTags } from "@/lib/web/html";

/**
 * What the guided setup reads from a site's homepage: its title
 * and description, the headings, and the business behind it and the towns it serves when the page
 * says so in schema.org data. Pure functions, no I/O: the page is fetched by `gather.ts`.
 */

export interface SiteBusiness {
  name: string;
  /** "Salem, NH" style: locality, then region when there is one. */
  city: string;
}

export interface SiteFacts {
  title: string | null;
  description: string | null;
  /** H1 to H3 text in page order, deduped, at most 20. */
  headings: string[];
  /** A business with a town in its structured data (its address, or the first town it serves), so Local SEO applies. */
  business: SiteBusiness | null;
  /** Towns the business serves, "Riverton, Ohio" style: its address first, then `areaServed`. At most 5. */
  cities: string[];
  /** The services the page lists under a heading like "Services Offered", lower case. */
  services?: string[];
  /** A service the description states as "X for Y": "hr consulting" in "HR consulting for startups". */
  offer?: string | null;
  /** Who the description says it's for: "startups", "small businesses". */
  audiences?: string[];
}

const MAX_HEADINGS = 20;
const MAX_CITIES = 5;

/** schema.org types that mean a place customers visit or a business serving an area. */
const LOCAL_TYPE = /(LocalBusiness|Store|Restaurant|Dentist|Physician|Attorney|Plumber|Electrician|Locksmith|Agency|Service|Contractor|Salon|Shop|Clinic|Hotel|Cafe|Bakery|Bar|Gym|Office)$/;

/** The headings' text, tags and entities removed. */
export function headings(html: string): string[] {
  const out: string[] = [];
  for (const h of elements(html, ["h1", "h2", "h3"])) {
    const text = decodeEntities(stripTags(h.inner)).replace(/\s+/g, " ").trim();
    if (text && text.length <= 200 && !out.includes(text)) out.push(text);
    if (out.length >= MAX_HEADINGS) break;
  }
  return out;
}

const MAX_SERVICES = 8;

/** A heading that introduces a list of services. */
const SERVICES_HEADING = /\b(services?|what (we|i) (do|offer)|offerings?|solutions|specialties|practice areas)\b/i;

/** The headings under a "Services" heading, one level down: where a site lists what it sells. */
export function serviceNames(html: string): string[] {
  const all = elements(html, ["h1", "h2", "h3", "h4"]).map((h) => ({
    level: Number(h.name.slice(1)),
    text: decodeEntities(stripTags(h.inner)).replace(/\s+/g, " ").trim(),
  }));
  const start = all.findIndex((h, i) => h.level <= 3 && SERVICES_HEADING.test(h.text) && all[i + 1]?.level > h.level);
  if (start < 0) return [];
  const out: string[] = [];
  for (const h of all.slice(start + 1)) {
    if (h.level <= all[start].level) break;
    const name = h.text.toLowerCase().replace(/&/g, "and").replace(/\s+/g, " ").trim();
    if (name && name.split(" ").length <= 5 && !/[?!:]/.test(name) && !out.includes(name)) out.push(name);
    if (out.length >= MAX_SERVICES) break;
  }
  return out;
}

/**
 * What a description says in the form "X for Y": the service and who it's for ("HR consulting for
 * startups, small businesses, and non-profits."). Only a short X that starts its sentence, since a
 * longer one is a sentence about the business rather than the name of a service.
 */
export function describedOffer(description: string | null): { offer: string | null; audiences: string[] } {
  for (const sentence of (description ?? "").split(/(?<=[.!?])\s+/)) {
    const m = sentence.match(/^([\p{L}][\p{L}&\s-]{2,40}?) for ([^.!?]+)[.!?]?$/u);
    if (!m) continue;
    const words = m[1].trim().split(/\s+/);
    if (words.length < 2 || words.length > 4 || /\b(is|are|we|our|i)\b/i.test(m[1])) continue;
    const audiences = m[2]
      .split(/,\s*(?:and\s+)?|\s+and\s+/)
      .map((a) => a.trim().toLowerCase())
      .filter((a) => a && a.split(" ").length <= 3);
    return { offer: m[1].trim().toLowerCase(), audiences };
  }
  return { offer: null, audiences: [] };
}

type Json = Record<string, unknown>;

function entities(value: unknown, out: Json[] = []): Json[] {
  if (Array.isArray(value)) for (const v of value) entities(v, out);
  else if (value && typeof value === "object") {
    const obj = value as Json;
    if (obj["@type"]) out.push(obj);
    for (const [k, v] of Object.entries(obj)) if (k !== "@context") entities(v, out);
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const typesOf = (e: Json) => (Array.isArray(e["@type"]) ? e["@type"] : [e["@type"]]).filter((t): t is string => typeof t === "string");
const list = (v: unknown) => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** Each JSON-LD block's entities, with a lookup for `{"@id": …}` references within the block. */
function jsonLd(html: string): { all: Json[]; byId: Map<string, Json> }[] {
  const out: { all: Json[]; byId: Map<string, Json> }[] = [];
  for (const block of jsonLdBlocks(html)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block.trim());
    } catch {
      continue;
    }
    const all = entities(parsed);
    out.push({ all, byId: new Map(all.filter((e) => typeof e["@id"] === "string").map((e) => [e["@id"] as string, e])) });
  }
  return out;
}

const isLocal = (e: Json) => typesOf(e).some((t) => LOCAL_TYPE.test(t)) || "openingHours" in e || "openingHoursSpecification" in e || "geo" in e;

/** The towns in an entity's address and `areaServed`: City entities (by reference too) and "Town, ST" strings. */
function townsOf(e: Json, byId: Map<string, Json>): string[] {
  const resolve = (v: unknown) => {
    const obj = v && typeof v === "object" ? (v as Json) : null;
    return obj && typeof obj["@id"] === "string" && !obj.name ? (byId.get(obj["@id"]) ?? obj) : obj;
  };
  /** The state a City sits in, followed up its `containedInPlace` chain a few steps. */
  const stateOf = (place: Json) => {
    let at: Json | null = place;
    for (let i = 0; at && i < 4; i++) {
      at = resolve(at.containedInPlace);
      if (at && typesOf(at).includes("State")) return str(at.name);
    }
    return "";
  };
  const out: string[] = [];
  const address = resolve(list(e.address)[0]);
  const town = str(address?.addressLocality);
  if (town) {
    const region = str(address?.addressRegion);
    out.push(region && region !== town ? `${town}, ${region}` : town);
  }
  for (const v of list(e.areaServed)) {
    if (typeof v === "string") {
      if (/^[^,]{2,40},\s*[A-Za-z][A-Za-z .]{1,30}$/.test(v.trim())) out.push(str(v));
      continue;
    }
    const place = resolve(v);
    const name = str(place?.name);
    if (!place || !name || !typesOf(place).includes("City")) continue;
    const region = stateOf(place) || str(resolve(place.address)?.addressRegion);
    out.push(region ? `${name}, ${region}` : name);
  }
  return out;
}

/** The town part of "Riverton, Ohio". */
export const townOf = (city: string) => city.split(",")[0].trim();

/** The towns the page's local businesses serve, deduped by town, at most 5. */
export function servedCities(html: string): string[] {
  const out: string[] = [];
  for (const { all, byId } of jsonLd(html))
    for (const e of all.filter(isLocal))
      for (const city of townsOf(e, byId)) if (out.length < MAX_CITIES && !out.some((c) => townOf(c).toLowerCase() === townOf(city).toLowerCase())) out.push(city);
  return out;
}

/**
 * The first local business in the page's JSON-LD that has a name and a town: its address's, or
 * for a service-area business with no street address, the first town it serves.
 */
export function localBusiness(html: string): SiteBusiness | null {
  for (const { all, byId } of jsonLd(html)) {
    for (const e of all) {
      const name = str(e.name);
      const town = isLocal(e) && name ? townsOf(e, byId)[0] : undefined;
      if (town) return { name, city: town };
    }
  }
  return null;
}

/** Sections whose pages are named after a subject people search for. */
const TOPIC_SECTION = /^\/(?:guides?|learn|resources|features?|solutions|use-cases|product|blog)\/([^/]+)\/?$/i;

const hrefs = (html: string) => openTags(html, "a").flatMap((t) => /\bhref=["']([^"'#?]+)["']/i.exec(t.raw)?.[1] ?? []);

/** A link's host and path, with "www." off the host; null for mail links and the like. */
function linkTo(href: string, domain: string): { host: string; path: string } | null {
  try {
    const url = new URL(decodeEntities(href), `https://${domain}/`);
    return /^https?:$/.test(url.protocol) ? { host: url.hostname.toLowerCase().replace(/^www\./, ""), path: url.pathname } : null;
  } catch {
    return null;
  }
}

const isSameSite = (host: string, domain: string) => host === domain.toLowerCase().replace(/^www\./, "");

/** A path segment decoded for reading. A stray "%" ("/100%-off") isn't an escape, so it stays as written. */
function decodedSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The subjects of a homepage's links into its guides and the like, in page order: "/guides/basecamp-change-history" is "basecamp change history". */
export function linkedTopics(html: string, domain: string): string[] {
  const out: string[] = [];
  for (const href of hrefs(html)) {
    const link = linkTo(href, domain);
    const slug = link && isSameSite(link.host, domain) ? link.path.match(TOPIC_SECTION)?.[1] : null;
    if (!slug) continue;
    const topic = decodedSegment(slug).toLowerCase().replace(/[-_]+/g, " ").trim();
    if (topic && !out.includes(topic)) out.push(topic);
  }
  return out;
}

/** The path of a page that compares a site with its rivals. */
export const COMPARE_PAGE = /^\/(?:vs|versus|compare|comparisons?|alternatives?)\/?$/i;

const COMPARE_CHILD = /^\/(?:vs|versus|compare|comparisons?|alternatives?)\/([^/]+)\/?$/i;

const squashed = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * The sites a comparison page compares this one with, in page order. Only a site the page gives its
 * own comparison ("/vs/madeup-reports" and a link to madeup-reports.com), or without those, names in a heading: the
 * same page also links to the app stores and to the help pages of whatever the product works with.
 */
export function comparedSites(page: string, domain: string): string[] {
  const links = hrefs(page).flatMap((href) => linkTo(href, domain) ?? []);
  const children = links.filter((l) => isSameSite(l.host, domain)).flatMap((l) => l.path.match(COMPARE_CHILD)?.[1] ?? []);
  const named = (children.length ? children : headings(page)).map(squashed);
  const out: string[] = [];
  for (const { host } of links) {
    if (isSameSite(host, domain) || out.includes(host)) continue;
    const labels = host.split(".").slice(0, -1).map(squashed).filter((l) => l.length >= 3);
    if (labels.some((l) => named.some((n) => n.includes(l)))) out.push(host);
  }
  return out;
}

export function siteFacts(html: string): SiteFacts {
  const facts = pageFacts(html);
  return {
    title: facts.title,
    description: facts.description,
    headings: headings(html),
    business: localBusiness(html),
    cities: servedCities(html),
    services: serviceNames(html),
    ...describedOffer(facts.description),
  };
}
