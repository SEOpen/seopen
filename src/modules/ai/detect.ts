/**
 * Brand mention and citation detection for AI answers. Pure functions, no I/O.
 *
 * A brand is the project or a competitor, keyed by its domain. Its names come from the
 * domain itself ("alphanote.example" → "alphanote", matched as AlphaNote, Alphanote, Alpha-Note,
 * "Alpha Note"), the project's own name for our brand ("Blue Pine Landscaping" for bpl.example),
 * plus any aliases the user adds ("Margin" for deltabarn.example).
 */
import type { AiBrandMention, AiCitation } from "@/db/schema/ai";

export interface Brand {
  /** Key: the project's or competitor's domain. */
  domain: string;
  own: boolean;
  /** Display name, e.g. "Margin". A competitor with no known name shows its domain. */
  name: string;
  /** Domains that count as this brand for citations (the key plus any alias that looks like a domain). */
  domains: string[];
  /** Names matched in the answer text. */
  names: string[];
}

export interface Span {
  start: number;
  end: number;
  domain: string;
  own: boolean;
}

/** Hosts where the brand lives in the subdomain, e.g. plainpad.github.io. */
const SHARED_HOSTS = new Set([
  "github.io",
  "gitlab.io",
  "vercel.app",
  "netlify.app",
  "pages.dev",
  "web.app",
  "firebaseapp.com",
  "herokuapp.com",
  "wordpress.com",
  "blogspot.com",
  "substack.com",
  "notion.site",
  "framer.website",
  "webflow.io",
]);
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

/** "https://www.Example.com/a?b" → "example.com". Keeps subdomains other than www. */
export function hostOf(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^www\./, "");
  return s.split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "");
}

/** The brand-ish label of a domain: "alphanote.example" → "alphanote", "foo.co.uk" → "foo", "plainpad.github.io" → "plainpad". */
export function domainLabel(domain: string): string {
  const parts = hostOf(domain).split(".").filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "";
  const lastTwo = parts.slice(-2).join(".");
  if (SHARED_HOSTS.has(lastTwo) && parts.length >= 3) return parts[parts.length - 3];
  const sld = parts[parts.length - 2];
  if (parts.length >= 3 && SECOND_LEVEL.has(sld) && parts[parts.length - 1].length === 2) return parts[parts.length - 3];
  return sld;
}

/**
 * The site a host belongs to, for grouping citations: "support.apple.com" → "apple.com",
 * "foo.co.uk" stays, "plainpad.github.io" stays (the brand lives in the subdomain).
 */
export function siteOf(host: string): string {
  const parts = hostOf(host).split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  const keep = SHARED_HOSTS.has(lastTwo) || (SECOND_LEVEL.has(parts[parts.length - 2]) && parts[parts.length - 1].length === 2) ? 3 : 2;
  return parts.slice(-keep).join(".");
}

export const looksLikeDomain = (s: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(hostOf(s)) && !/\s/.test(s.trim());

/** Build a Brand from its domain and user aliases. */
export function makeBrand(domain: string, own: boolean, aliases: string[] = []): Brand {
  const key = hostOf(domain);
  const label = domainLabel(key);
  const domains = new Set([key]);
  const names = new Set<string>([label]);
  for (const raw of aliases) {
    const a = raw.trim();
    if (!a) continue;
    if (!looksLikeDomain(a) && [...names].some((n) => n.toLowerCase() === a.toLowerCase())) continue;
    if (looksLikeDomain(a)) {
      domains.add(hostOf(a));
      names.add(domainLabel(a));
    } else {
      names.add(a);
    }
  }
  // A product name becomes the display name only when the domain name isn't part of any alias
  // (deltabarn.example + "Margin" → Margin; jotwell.example + "Jotwell Pro" → Jotwell).
  const names_ = aliases.map((a) => a.trim()).filter((a) => a && !looksLikeDomain(a));
  const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const product = names_.some((a) => squash(a).includes(label)) ? undefined : names_[0];
  // A name that is the domain's name spelled properly ("Harlow SEO" for harlowseo.com) shows as typed, not as "Harlowseo".
  const spelled = names_.find((a) => squash(a) === squash(label));
  // The label capitalised is a made-up name for a competitor ("Harlowseo"), so it shows its domain instead,
  // unless a name it goes by really uses the label as a word ("Jotwell Pro"). Our own brand keeps the label.
  const usesLabel = names_.some((a) => a.toLowerCase().split(/[^\p{L}\p{N}]+/u).includes(label));
  return {
    domain: key,
    own,
    name: product ?? spelled ?? (own || usesLabel ? label.charAt(0).toUpperCase() + label.slice(1) : key),
    domains: [...domains],
    names: [...names].filter((n) => n.length >= 2),
  };
}

/**
 * The project's name as a brand name: "Alphanote (main site)" → "Alphanote". A trailing
 * parenthetical is dropped since it usually describes the project, not the brand. Null when
 * nothing usable is left.
 */
export function projectNameAlias(name: string | null | undefined): string | null {
  const n = (name ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim();
  return n.length >= 2 ? n : null;
}

/**
 * Our own brand: the project's domain, its user aliases, and the project's name, so a
 * business named differently from its domain ("Blue Pine Landscaping" on bpl.example) is found.
 * User aliases come first, so one of them stays the display name when set.
 */
export function ownBrand(project: { domain: string; name: string | null }, aliases: string[] = []): Brand {
  const fromName = projectNameAlias(project.name);
  const brand = makeBrand(project.domain, true, fromName ? [...aliases, fromName] : aliases);
  // Display name: a user alias's product name wins; otherwise the project name as typed. Not via
  // makeBrand, whose product-name rule would drop "Beta Web Design" for "Betaweb" since
  // the domain label is part of it. A project named after its domain keeps the domain label.
  const plain = makeBrand(project.domain, true).name;
  const userName = makeBrand(project.domain, true, aliases).name;
  const name = userName !== plain || !fromName || looksLikeDomain(fromName) ? userName : fromName;
  return { ...brand, name };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A character class matching c in either case: "a" → "[aA]". */
const ci = (c: string) => (c.toLowerCase() !== c.toUpperCase() ? `[${c.toLowerCase()}${c.toUpperCase()}]` : escapeRe(c));

/**
 * Regex source for one brand name.
 * - Domains match literally ("alphanote.test").
 * - Multi-word names match with any space/hyphen between the words, any case.
 * - Single-word names match in any case, joined with a hyphen ("Alpha-Note") in any case,
 *   or split by a space only when both halves are capitalized ("Alpha Note"), so "gammanest"
 *   doesn't fire on the phrase "gamma nest".
 */
export function namePattern(name: string): string {
  const n = name.trim();
  if (looksLikeDomain(n) && n.includes(".")) return n.split("").map(ci).join("");
  const words = n.split(/[\s\-_]+/).filter(Boolean);
  if (words.length > 1) return words.map((w) => w.split("").map(ci).join("")).join("[\\s\\-]+");
  const w = words[0] ?? "";
  const alts = [w.split("").map(ci).join(""), w.split("").map(ci).join("-?")];
  if (w.length >= 5) {
    for (let i = 2; i <= w.length - 2; i++) {
      const a = w.slice(0, i);
      const b = w.slice(i);
      alts.push(`${escapeRe(a[0].toUpperCase())}${a.slice(1).split("").map(ci).join("")} ${escapeRe(b[0].toUpperCase())}${b.slice(1).split("").map(ci).join("")}`);
    }
  }
  return `(?:${alts.join("|")})`;
}

/** Matcher for all of a brand's names, with letter/digit boundaries on both sides. */
export function brandRegex(brand: Brand): RegExp {
  const names = [...new Set([...brand.names, ...brand.domains])].sort((a, b) => b.length - a.length);
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(namePattern).join("|")})(?![\\p{L}\\p{N}])`, "gu");
}

/** True when the text names the brand by any of its names or domains, e.g. a prompt that asks about us. */
export function namesBrand(text: string, brand: Brand): boolean {
  return brandRegex(brand).test(text);
}

/** Every match of every brand, as non-overlapping spans sorted by position (longer match wins). */
export function findSpans(text: string, brands: Brand[]): Span[] {
  const all: Span[] = [];
  for (const b of brands) {
    for (const m of text.matchAll(brandRegex(b))) {
      all.push({ start: m.index, end: m.index + m[0].length, domain: b.domain, own: b.own });
    }
  }
  all.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const out: Span[] = [];
  for (const s of all) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) continue;
    out.push(s);
  }
  return out;
}

const TRACKING_PARAMS = /^(utm_[a-z]+|gclid|fbclid|ref|ref_src)$/i;

/** Drop tracking params and the fragment, so the same page cited twice dedupes. */
export function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
    u.hash = "";
    return u.toString();
  } catch {
    return raw;
  }
}

/** Gemini links every source through this Google redirect and names the real site only in the title. */
const GROUNDING_REDIRECT = /^https?:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//i;

/** A Gemini redirect: the link works for a while, but its address isn't the page. */
export const isGeminiRedirect = (url: string) => GROUNDING_REDIRECT.test(url);

/** The site a citation really belongs to: the title's domain for a Gemini redirect, else the URL's host. */
function citationDomain(url: string, title: string | null | undefined): string {
  return GROUNDING_REDIRECT.test(url) && title && looksLikeDomain(title) ? hostOf(title) : hostOf(url);
}

/**
 * A search-result breadcrumb glued to the front of a title: "www.designrush.com › agency › website-designTop
 * Salem Web Designers". A host, then " › " segments; the last segment ends where the real title starts,
 * at a capital letter or a quote.
 */
const BREADCRUMB = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\s*›\s*[^\s›]+?)+(?=\s*[A-Z"“‘(])/;

/** A citation's title without a breadcrumb in front. A title that is all breadcrumb stays as it was. */
export function cleanTitle(title: string | null | undefined): string | null {
  if (!title) return title ?? null;
  const rest = title.replace(BREADCRUMB, "").trim();
  return rest || title;
}

/** A stored citation as the pages show it. */
export interface CitationView {
  url: string;
  /** The site it belongs to, or null when a Gemini redirect hides it. */
  domain: string | null;
  title: string | null;
  /** Gemini's redirect: the link works for a while, but its address isn't the page. */
  gemini: boolean;
}

/**
 * Reads a stored citation the way extractCitations would write it now, so rows from before a fix read the
 * same as new ones: a Gemini redirect counts under the site its title names (whose title is then only that
 * name), or under no site at all, never under Google's redirect host. Titles lose a breadcrumb in front.
 */
export function readCitation(c: AiCitation): CitationView {
  if (!GROUNDING_REDIRECT.test(c.url)) return { url: c.url, domain: c.domain, title: cleanTitle(c.title), gemini: false };
  const named = !!c.title && looksLikeDomain(c.title);
  return { url: c.url, domain: named ? citationDomain(c.url, c.title) : null, title: named ? null : cleanTitle(c.title), gemini: true };
}

/** What a citation's link reads: its address, or what's known of a Gemini redirect. */
export function citationLabel(c: CitationView): string {
  if (!c.gemini) return c.url.replace(/^https?:\/\//, "");
  return c.domain ? `Gemini link to ${c.domain}` : "Gemini link, source hidden";
}

/**
 * Citations: annotation URLs first (in order), then markdown links and bare URLs in the text.
 * Deduped by cleaned URL.
 */
export function extractCitations(text: string, annotations: { url?: string | null; title?: string | null }[] = []): AiCitation[] {
  const seen = new Map<string, AiCitation>();
  const add = (url: string, title?: string | null) => {
    if (!/^https?:\/\//i.test(url)) return;
    const clean = cleanUrl(url.replace(/[).,;:!?\]]+$/, ""));
    if (seen.has(clean)) return;
    seen.set(clean, { url: clean, domain: citationDomain(clean, title), title: cleanTitle(title) });
  };
  for (const a of annotations) if (a.url) add(a.url, a.title);
  // A link's text is what the answer calls the page ("Moz Pro"), not its title, so only a Gemini
  // redirect keeps it: there it can name the site.
  for (const m of text.matchAll(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g)) add(m[2], isGeminiRedirect(m[2]) ? m[1] || null : null);
  for (const m of text.matchAll(/https?:\/\/[^\s)<>\]"']+/g)) add(m[0]);
  return [...seen.values()];
}

/** True when `host` is `domain` or a subdomain of it. */
export function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export interface Detection {
  mentions: AiBrandMention[];
  /** Our brand is named. */
  mentioned: boolean;
  /** One of our URLs is cited. */
  cited: boolean;
  /** Our position among tracked brands (1 = named first), or null. */
  position: number | null;
}

/** Run mention and citation detection for every brand over one answer. */
export function detect(text: string, citations: AiCitation[], brands: Brand[]): Detection {
  const spans = findSpans(text, brands);
  const first = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const s of spans) {
    if (!first.has(s.domain)) first.set(s.domain, s.start);
    counts.set(s.domain, (counts.get(s.domain) ?? 0) + 1);
  }
  const order = [...first.entries()].sort((a, b) => a[1] - b[1]).map(([d]) => d);
  const mentions: AiBrandMention[] = brands.map((b) => ({
    domain: b.domain,
    own: b.own,
    count: counts.get(b.domain) ?? 0,
    firstOffset: first.get(b.domain) ?? null,
    position: first.has(b.domain) ? order.indexOf(b.domain) + 1 : null,
    cited: citations.some((c) => b.domains.some((d) => hostMatches(c.domain, d))),
  }));
  const own = mentions.find((m) => m.own);
  return {
    mentions,
    mentioned: (own?.count ?? 0) > 0,
    cited: own?.cited ?? false,
    position: own?.position ?? null,
  };
}

/** Split text into plain and highlighted segments for rendering. */
export function segments(text: string, spans: Span[]): { text: string; span?: Span }[] {
  const out: { text: string; span?: Span }[] = [];
  let i = 0;
  for (const s of spans) {
    if (s.start > i) out.push({ text: text.slice(i, s.start) });
    out.push({ text: text.slice(s.start, s.end), span: s });
    i = s.end;
  }
  if (i < text.length) out.push({ text: text.slice(i) });
  return out;
}
