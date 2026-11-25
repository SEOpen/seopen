/**
 * Which of a page's searches its text covers, for the "Refresh this page" panel.
 * Pure functions over text and Search Console rows, so the page, the MCP tool and the tests read
 * the same rules. No body copy is ever written from these: they only say which searches, questions and
 * words the page is missing.
 *
 * Text is normalised the same way on both sides: lowercased, split into words, stop words dropped, and each
 * word cut to a rough stem ("repairs" and "repairing" both read "repair"). A search is covered when every
 * one of its words is on the page, partly covered when at least half are, and missing otherwise.
 */

import { CHROME, decodeEntities, elements, pageFacts, stripComments, stripTags, visibleText, wordCount } from "@/lib/web/html";

/** Words that carry no topic. Question words go too: "how much is a plumber" is about plumbers. */
const STOP_WORDS = new Set(
  (
    "a about after all also am an and any are as at be been before being but by can could did do does doing for from had has have " +
    "having he her here hers him his how i if in into is it its just many me more most much my near no nor not of off on once only or other our " +
    "ours out over own same she should so some such than that the their theirs them then there these they this those through to too " +
    "s t under until up very vs was we were what whats when where which while who whom why will with would you your yours"
  ).split(" "),
);

const VOWEL = /[aeiouy]/;

/**
 * A rough stem: plurals and common verb endings cut, so a page that says "repairs" covers "repair" and
 * "repairing". Crude on purpose: the same cut runs on the page and the search, so it only has to agree with itself.
 */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (/(?:x|z|ch|sh|ss)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith("s") && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);
  for (const end of ["ing", "ed"]) {
    if (!w.endsWith(end)) continue;
    const base = w.slice(0, -end.length);
    if (base.length < 3 || !VOWEL.test(base)) continue;
    // "running" → "runn" → "run"; "repaired" → "repair".
    w = /([b-df-hj-np-tv-z])\1$/.test(base) && !/(?:ll|ss|zz)$/.test(base) ? base.slice(0, -1) : base;
    break;
  }
  return w;
}

/**
 * Lowercased words with accents folded, in order. Accents go before `normalize` as well as after,
 * so it has no long run of them to sort.
 */
export function words(text: string): string[] {
  return (
    text
      .toLowerCase()
      .replace(/\p{M}/gu, "")
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/** A text's topic words: stop words out, each stemmed. */
export function terms(text: string): string[] {
  return words(text)
    .filter((w) => !STOP_WORDS.has(w))
    .map(stem);
}

/** The set of stems a page's text holds, to test searches against. */
export function termSet(...texts: (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) if (t) for (const term of terms(t)) out.add(term);
  return out;
}

export type CoverageLabel = "covered" | "partly" | "missing";

export interface Coverage {
  label: CoverageLabel;
  /** The search's words found on the page and not, as typed (not stemmed). */
  found: string[];
  absent: string[];
}

/** The shortest part a run-together word is split into. */
const MIN_PART = 3;
/** Longer words aren't tried as run-together words. */
const MAX_GLUED = 40;

/**
 * A run-together word whose parts are all on the page: "checkbacklinks" on a page that says "check" and
 * "backlinks", "opensiteexplorer" on one that says "open site explorer". People type searches glued, and
 * the page already has the words.
 */
export function gluedOnPage(word: string, page: Set<string>): boolean {
  if (word.length < MIN_PART * 2 || word.length > MAX_GLUED) return false;
  const has = (part: string) => page.has(part) || page.has(stem(part));
  // ends[i]: the first i letters split into page words, and how few parts that took.
  const ends: number[] = new Array(word.length + 1).fill(Infinity);
  ends[0] = 0;
  for (let i = 0; i < word.length; i++) {
    if (ends[i] === Infinity) continue;
    for (let j = i + MIN_PART; j <= word.length; j++) if (ends[i] + 1 < ends[j] && has(word.slice(i, j))) ends[j] = ends[i] + 1;
  }
  const parts = ends[word.length];
  return parts >= 2 && parts < Infinity;
}

/**
 * How much of a search a page's text covers. A search made only of stop words ("how to") is read word for
 * word instead, so it still gets a label. A run of two to four words whose initials the page uses as a
 * word counts as found: a page that says "SEO" covers "search engine optimization". So does a run-together
 * word whose parts the page has (`gluedOnPage`).
 */
export function coverage(search: string, page: Set<string>): Coverage {
  const all = words(search);
  const topical = all.filter((w) => !STOP_WORDS.has(w));
  const list = [...new Set(topical.length ? topical : all)];
  const hit = new Set(list.filter((w) => page.has(stem(w)) || page.has(w) || gluedOnPage(w, page)));
  for (let i = 0; i < list.length; i++) {
    for (let n = 4; n >= 2; n--) {
      const run = list.slice(i, i + n);
      if (run.length < n) continue;
      const initials = run.map((w) => w[0]).join("");
      if (page.has(initials) || page.has(stem(initials))) for (const w of run) hit.add(w);
    }
  }
  const found = list.filter((w) => hit.has(w));
  const absent = list.filter((w) => !hit.has(w));
  if (!list.length) return { label: "missing", found, absent };
  const share = found.length / list.length;
  return { label: share === 1 ? "covered" : share >= 0.5 ? "partly" : "missing", found, absent };
}

/** How much a search's impressions count, by how close the page is to page one. */
export function positionWeight(position: number): number {
  if (position <= 10) return 1;
  if (position <= 20) return 0.7;
  return 0.3;
}

export const WEIGHT_NOTE = "Ranked by impressions × a weight for position: 1 at positions 1 to 10, 0.7 at 11 to 20, 0.3 further down.";

export interface SearchRow {
  query: string;
  impressions: number;
  clicks: number;
  position: number;
}

export interface SearchCoverage extends SearchRow, Coverage {
  /** impressions × positionWeight(position), rounded. */
  score: number;
  /** Another page of the site that Google prefers for this search (`ownerOf`): it isn't this page's to chase. */
  ownedBy?: SearchOwner;
}

/** The page Google shows most for a search, over the same period. */
export interface SearchOwner {
  page: string;
  impressions: number;
  position: number;
}

/**
 * The page that owns a search instead of this one: another page with more impressions for it at
 * the same or a better position. Telling this page to chase that search ("put salem in the
 * Windham title") would set the two pages against each other. Null when this page leads.
 */
export function ownerOf(own: SearchRow, others: SearchOwner[]): SearchOwner | null {
  const best = [...others].sort((a, b) => b.impressions - a.impressions || a.position - b.position || a.page.localeCompare(b.page))[0];
  return best && best.impressions > own.impressions && best.position <= own.position ? best : null;
}

const ORDER: Record<CoverageLabel, number> = { missing: 0, partly: 1, covered: 2 };

/** Every search labelled, missing first, then partly covered, each by score; covered ones by impressions. */
export function coverSearches(rows: SearchRow[], page: Set<string>): SearchCoverage[] {
  return rows
    .map((r) => ({ ...r, ...coverage(r.query, page), score: Math.round(r.impressions * positionWeight(r.position)) }))
    .sort((a, b) => ORDER[a.label] - ORDER[b.label] || b.score - a.score || b.impressions - a.impressions || a.query.localeCompare(b.query));
}

/**
 * One row per search when the page shows under several addresses (http and https, with and without www or a
 * trailing slash): impressions and clicks summed, position averaged by impressions.
 */
export function mergeSearches(lists: SearchRow[][]): SearchRow[] {
  const by = new Map<string, { impressions: number; clicks: number; weighted: number }>();
  for (const r of lists.flat()) {
    const cur = by.get(r.query) ?? { impressions: 0, clicks: 0, weighted: 0 };
    cur.impressions += r.impressions;
    cur.clicks += r.clicks;
    cur.weighted += r.position * r.impressions;
    by.set(r.query, cur);
  }
  return [...by]
    .map(([query, v]) => ({ query, impressions: v.impressions, clicks: v.clicks, position: v.impressions ? Math.round((v.weighted / v.impressions) * 10) / 10 : 0 }))
    .filter((r) => r.impressions > 0)
    .sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query));
}

/**
 * The brand's name, from the domain: "www.alphanote.test" → "alphanote", "fernhill-plumbing.co.uk" → "fernhillplumbing". A
 * hyphenated name isn't split, since its parts are often ordinary words.
 */
export function brandTerms(domain: string): Set<string> {
  const host = domain.toLowerCase().replace(/^www\./, "");
  const name = (host.split(".")[0] ?? "").replace(/[^a-z0-9]/g, "");
  return new Set(name.length > 2 ? [name] : []);
}

/** A search that names the brand: its words, or two of them run together, spell the domain's name. */
export function isBrandSearch(search: string, brand: Set<string>): boolean {
  const w = words(search);
  if (w.some((x) => brand.has(x))) return true;
  for (let i = 0; i + 1 < w.length; i++) if (brand.has(w[i] + w[i + 1])) return true;
  return false;
}

/**
 * Common words of Spanish, Portuguese, German, French, Italian and Dutch searches, accents folded, that
 * aren't also English words. An English page gets searches in other languages from Google's other
 * markets, and "use comprobar" is no task for it. A short list on purpose: it catches the usual verbs and
 * glue words of tool searches, not every foreign word.
 */
const NOT_ENGLISH = new Set(
  (
    "comprobar checar buscar revisar verificar analizar consultar ver herramienta herramientas gratuito gratuita enlaces pagina paginas sitio posicionamiento palabras clave para " +
    "ferramenta ferramentas gratuitos verificador " +
    "checken testen prufen uberprufen suchen finden anzeigen kostenlos kostenlose und oder werkzeug " +
    "verifier trouver gratuit outil outils avec pour " +
    "controllare verificare strumento strumenti gratuiti " +
    "controleren zoeken voor"
  ).split(" "),
);

/** A search with a common word of another language, on an English project. Other languages aren't read, so nothing is left out for them. */
export function otherLanguage(search: string, languageCode: string): boolean {
  if (!/^en\b/i.test(languageCode)) return false;
  return words(search).some((w) => NOT_ENGLISH.has(w));
}

/** Fewest topic words for a search to be preferred as the main search for matching the title or H1. */
const MAIN_MIN_TERMS = 2;

/**
 * The page's main search. Among its non-brand searches of at least two topic words, the one with the most
 * impressions whose words are mostly (more than half) in the title or H1: it's what the page is about. With
 * none, the non-brand search with the most impressions, or the top one when every search names the brand.
 * A short search with more impressions ("see rank") doesn't win over one the page was written for ("search
 * rank tracker" on a page titled "Daily rank tracker").
 */
export function mainSearch<T extends SearchRow>(rows: T[], brand: Set<string>, heading: Set<string> = new Set()): T | null {
  const sorted = [...rows].sort((a, b) => b.impressions - a.impressions);
  const unbranded = sorted.filter((r) => !isBrandSearch(r.query, brand));
  const fits = unbranded.find((r) => {
    const c = coverage(r.query, heading);
    const n = c.found.length + c.absent.length;
    return n >= MAIN_MIN_TERMS && c.found.length * 2 > n;
  });
  return fits ?? unbranded[0] ?? sorted[0] ?? null;
}

/** Searches the title is checked against for a second intent. */
export const INTENT_SEARCHES = 10;

/**
 * Two of the page's top searches that share no topic word, each at least partly in the title: a title that
 * tries to win both may serve neither. Brand searches are left out, since a brand name in a title is normal.
 * The pair with the most impressions together, or null.
 */
export function titleIntents<T extends SearchRow>(title: string | null, rows: T[], brand: Set<string>): [T, T] | null {
  if (!title) return null;
  const inTitle = termSet(title);
  const top = [...rows]
    .filter((r) => !isBrandSearch(r.query, brand))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, INTENT_SEARCHES)
    .filter((r) => coverage(r.query, inTitle).label !== "missing")
    .map((r) => ({ r, t: new Set(terms(r.query)) }))
    .filter((x) => x.t.size > 0);
  let best: [T, T] | null = null;
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      if ([...top[i].t].some((t) => top[j].t.has(t))) continue;
      const pair: [T, T] = [top[i].r, top[j].r];
      if (!best || pair[0].impressions + pair[1].impressions > best[0].impressions + best[1].impressions) best = pair;
    }
  }
  return best;
}

/** Fewer internal links in than this, and fewer than the site's typical page, reads as few. */
export const FEW_LINKS_IN = 3;

/** Whether a page gets few internal links: under FEW_LINKS_IN and under the crawl's median. */
export function fewLinksIn(linksIn: number | null, median: number | null): boolean {
  if (linksIn == null) return false;
  return linksIn < FEW_LINKS_IN && (median == null || linksIn < median);
}

export interface PaaElement {
  type?: string;
  title?: string | null;
}

/** People also ask questions from a Google results page, in page order, without repeats. */
export function paaQuestions(items: { type: string; items?: PaaElement[] | null }[] | null | undefined): string[] {
  const out: string[] = [];
  for (const item of items ?? []) {
    if (item.type !== "people_also_ask") continue;
    for (const el of item.items ?? []) {
      const q = el.title?.trim();
      if (q && !out.includes(q)) out.push(q);
    }
  }
  return out;
}

/**
 * Whether a People also ask question fits the page: past the main search's own words, more than half of
 * its topic words are already on the page, so answering it extends what the page says. "Is buying
 * backlinks illegal?" on a backlink checker's page shares only "backlink" and is another page's topic. A
 * question made only of the main search's words fits.
 */
export function questionFits(question: string, main: string, page: Set<string>): boolean {
  const own = new Set(terms(main));
  const extra = [...new Set(terms(question))].filter((t) => !own.has(t));
  if (!extra.length) return true;
  return extra.filter((t) => page.has(t)).length * 2 > extra.length;
}

export interface Heading {
  level: 1 | 2 | 3;
  text: string;
}

export interface PageText {
  title: string | null;
  /** H1 to H3 in page order. */
  headings: Heading[];
  /** Visible body text. */
  body: string;
  words: number;
  /** An app shell: the content arrives with JavaScript, so the raw HTML shows little of it. */
  jsShell: boolean;
}

/**
 * What a crawler that doesn't run JavaScript reads on a page: title, H1 to H3 and body text. Headings are
 * the page's own, as `contentWordCount` reads content: inside `<main>` when there is one, otherwise outside
 * the header, nav, footer and aside every page repeats. An `<aside>` inside `<main>` is left out too: it's
 * a sidebar or a closing call to action, not the page's outline (QA B8). An H1 counts wherever it is,
 * since some sites put the page's H1 in its header.
 */
export function readPage(html: string): PageText {
  const facts = pageFacts(html);
  const doc = stripComments(html);
  const main = elements(doc, ["main"], 1)[0];
  const chrome = elements(doc, main ? ["aside"] : CHROME);
  // Both lists are in page order, so each heading carries on from the last one's place among the chrome.
  let next = 0;
  const inChrome = (at: number) => {
    while (next < chrome.length && chrome[next].end <= at) next++;
    return next < chrome.length && at >= chrome[next].start;
  };
  const own = (at: number) => (!main || (at >= main.start && at < main.end)) && !inChrome(at);
  const headings = elements(doc, ["h1", "h2", "h3"])
    .filter((e) => e.name === "h1" || own(e.start))
    .map((e) => ({ level: Number(e.name.slice(1)) as Heading["level"], text: decodeEntities(stripTags(e.inner)).replace(/\s+/g, " ").trim() }))
    .filter((h) => h.text);
  const body = visibleText(html);
  return { title: facts.title, headings, body, words: wordCount(body), jsShell: facts.jsShell };
}
