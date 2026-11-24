/** Keyword ⇄ prompt helpers and cost estimates. Pure functions, no I/O. */
import { AIO_COST_USD, platformDef, RUNS_PER_MONTH } from "./platforms";

/**
 * "Suggest prompts" spends research credits: a Labs lookup of up to 100 keywords the site ranks for,
 * and a second of keywords for the site when it ranks for few (dfs.ts, fetchProjectKeywords). Labs
 * prices a task at $0.012 plus $0.00012 a row (labsCost in keywords/requests.ts). The button shows
 * the most both can cost, and neither is charged more than its share.
 */
export const SUGGEST_LOOKUP_USD = 0.012 + 0.00012 * 100;
export const SUGGEST_MAX_USD = 2 * SUGGEST_LOOKUP_USD;

const QUESTION_START = /^(how|what|what's|which|why|where|when|who|can|could|is|are|does|do|should|will)\b/i;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Rough plural check for the last word: "apps" yes, "canvas", "glass", "macos" no. */
const plural = (s: string) => /[^suaio]s$/.test(s);
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** People who do the work, as a keyword's last word: "Who is the best web designer in Riverton?" */
export const PERSON = /^(designer|developer|consultant|contractor|plumber|electrician|roofer|dentist|lawyer|attorney|doctor|realtor|agent|photographer|freelancer|expert|specialist|mechanic|therapist|accountant)s?$/;
/** Businesses, as a keyword's last word: "What's the best web design agency in Riverton?" */
const BUSINESS = /^(agency|agencies|company|companies|firms?|studios?|shops?|stores?|restaurants?|salons?|clinics?|gyms?|hotels?|bakery|bakeries|cafes?|schools?)$/;

/** A place's spelling inside a keyword: lower case, no dots or commas, "saint" as "st". */
const placeKey = (s: string) => squash(s.toLowerCase().replace(/[.,]/g, " ").replace(/\bsaint\b/g, "st"));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The keyword without the town it names at its start or end ("web design riverton oh"), and that place as given. */
function splitPlace(kw: string, places: string[]): { what: string; place: string } | null {
  const k = placeKey(kw);
  for (const place of places) {
    const town = placeKey(place.split(",")[0]);
    if (!town) continue;
    const t = escape(town);
    const m = k.match(new RegExp(`^(.+?) (?:in |near )?${t}(?: [a-z]{2})?$`)) ?? k.match(new RegExp(`^${t}(?: [a-z]{2})? (.+)$`));
    const what = m?.[1].replace(/^(best|top|good) /, "").trim();
    if (what && !QUESTION_START.test(what)) return { what, place };
  }
  return null;
}

/**
 * The word a keyword asks about, which the question agrees with: the last word before "for", "in" or
 * "near" ("journals for macos"), or a word naming the work, the people or the business when a town
 * follows it ("seo services salem nh", "plumbers salem"). Otherwise the last word.
 */
function headWord(kw: string): string {
  const words = kw.split(" ");
  const cut = words.findIndex((w, i) => i > 0 && /^(for|in|near|with|on)$/.test(w));
  const before = cut > 0 ? words.slice(0, cut) : words;
  const named = [...before].reverse().find((w) => /^services?$/.test(w) || PERSON.test(w) || BUSINESS.test(w));
  return named ?? before[before.length - 1];
}

/** A quality rather than a thing to pick: "ai visibility", "brand awareness". "The best AI visibility" isn't a question. */
const QUALITY = /(ility|ivity|ness)$/;

/** "What is the best X?", with the verb and question word for what X is: "Who offers the best seo services salem nh?" Empty when X can't be the best of anything. */
function bestQuestion(what: string): string {
  const head = headWord(what);
  if (QUALITY.test(head)) return "";
  if (/^services?$/.test(head)) return `Who offers the best ${what}?`;
  if (PERSON.test(head)) return `Who ${plural(head) ? "are" : "is"} the best ${what}?`;
  return `What ${plural(head) ? "are" : "is"} the best ${what}?`;
}

/** The places a project's keywords may name: the towns confirmed in setup, else the city rank tracking searches from. */
export function projectPlaces(project: { servedTowns: string[] | null; cityName: string | null }): string[] {
  if (project.servedTowns?.length) return project.servedTowns;
  return project.cityName ? [project.cityName] : [];
}

/** A local search as people ask an assistant: "Who does the best web design in Riverton, Ohio?" */
function localQuestion(what: string, place: string): string {
  const last = what.split(" ").pop()!;
  const many = /s$/.test(last) && !/ss$/.test(last);
  if (PERSON.test(last)) return `Who ${many ? "are" : "is"} the best ${what} in ${place}?`;
  if (BUSINESS.test(last)) return `${many ? "What are" : "What's"} the best ${what} in ${place}?`;
  if (/^services?$/.test(last)) return `Who offers the best ${what} in ${place}?`;
  return `Who does the best ${what} in ${place}?`;
}

/**
 * Turn a search keyword into a natural question, e.g. "best mac journal" → "What is the best mac journal?"
 * With `places` (towns a business serves, "Riverton, Ohio" style), a keyword naming one of them at
 * its start or end becomes a local question: "web design riverton" → "Who does the best web design in Riverton, Ohio?"
 */
export function keywordToPrompt(keyword: string, places: string[] = []): string {
  // "reddit" on the end asks Google for forum threads; an assistant is just asked the question.
  let kw = squash(keyword.toLowerCase().replace(/[?!.]+$/, "")).replace(/ (reddit|quora|youtube)$/, "");
  if (!kw) return "";
  let m = kw.match(/^how to (.+)$/);
  if (m) return `How do I ${m[1]}?`;
  if (QUESTION_START.test(kw)) return `${cap(kw)}?`;
  // A price word on the end goes in front, where a question puts it: "seo tools free" → "free seo tools".
  kw = kw.replace(/^(.+) (free|cheap|cheaper)$/, "$2 $1");
  const local = splitPlace(kw, places);
  if (local) return localQuestion(local.what, local.place);
  m = kw.match(/^(.+?) vs\.? (.+)$/);
  if (m) return `Which is better, ${m[1]} or ${m[2]}?`;
  m = kw.match(/^(?:(free|cheap|cheaper) )?(.+?) alternatives?$/) ?? kw.match(/^(?:(free|cheap|cheaper) )?alternatives? (?:to|for) (.+)$/);
  if (m) return m[1] === "free" ? `What are the best free alternatives to ${m[2]}?` : m[1] ? `What are cheaper alternatives to ${m[2]}?` : `What are the best alternatives to ${m[2]}?`;
  // "Cheaper" with nothing to compare against has no question to make.
  if (kw.startsWith("cheaper ")) return "";
  m = kw.match(/^best (.+)$/);
  if (m) return bestQuestion(m[1]);
  m = kw.match(/^(?:top|free) (.+)$/);
  if (m) return `What are the best ${kw.startsWith("free") ? "free " : ""}${m[1]}?`;
  return bestQuestion(kw);
}

const LEADING = [
  /^(what|which|who) (is|are) (the )?(best|top|good)\s+/i,
  /^who (does|offers|has) (the )?(best|top|good)\s+/i,
  /^(what|which) (is|are) (some |a )?(good )?/i,
  /^(can you )?(recommend|suggest) (me )?(a |an |some )?(good )?/i,
  /^how (do|can|should) (i|you|we) /i,
  /^(what|which) /i,
  /^(is|are|does|do|should|can) /i,
];

/** The keyword form of a prompt, for the AI Overview check: "What are the best X in 2026?" → "best x". */
export function promptToKeyword(prompt: string): string {
  let s = squash(prompt.toLowerCase().replace(/[?!.]+$/, "")).replace(/^(what|who)['’]s /, "$1 is ");
  const vs = s.match(/^which (?:is|one is) better,? (.+?) or (.+)$/);
  if (vs) return `${vs[1]} vs ${vs[2]}`.slice(0, 200);
  const best = /^((what|which|who) (is|are)|who (does|offers|has)) (the )?(best|top) /.test(s);
  for (const re of LEADING) {
    const next = s.replace(re, "");
    if (next !== s) {
      s = next;
      break;
    }
  }
  s = s.replace(/\b(in|for) (19|20)\d\d\b/g, "").replace(/\b(19|20)\d\d\b/g, "");
  s = squash(s.replace(/^(the|a|an) /, ""));
  if (best && s) s = `best ${s}`;
  return s.slice(0, 200);
}

export interface CostRates {
  /** Average cost per answer, by platform key. */
  perAnswer: Record<string, number>;
  aio: number;
}

/** Cost per answer: observed averages where we have them, else the platform default. */
export function ratesFrom(observed: Record<string, number | null | undefined>): CostRates {
  const perAnswer: Record<string, number> = {};
  for (const key of ["chat_gpt", "perplexity", "gemini", "claude"]) {
    const o = observed[key];
    perAnswer[key] = o != null && o > 0 ? o : (platformDef(key)?.defaultCostUsd ?? 0.01);
  }
  return { perAnswer, aio: AIO_COST_USD };
}

/** Cost of one run of these prompts (answers on every selected platform, plus the AI Overview check). */
export function runCost(prompts: { platforms: string[]; keyword?: string | null }[], rates: CostRates): number {
  let total = 0;
  for (const p of prompts) {
    for (const pl of p.platforms) total += rates.perAnswer[pl] ?? 0.01;
    if (p.keyword) total += rates.aio;
  }
  return total;
}

/** Monthly cost at the weekly schedule. */
export function monthlyCost(prompts: { platforms: string[]; keyword?: string | null }[], rates: CostRates): number {
  return runCost(prompts, rates) * RUNS_PER_MONTH;
}

/** Round an estimate for display: to the cent from $0.10, to a tenth of a cent below. */
export function roundUsd(n: number): number {
  return n >= 0.1 ? Math.round(n * 100) / 100 : Math.round(n * 1000) / 1000;
}

/** A topic as stored: trimmed, single-spaced, at most 60 characters; empty → null. */
export function normalizeTopic(topic: string | null | undefined): string | null {
  const t = squash(topic ?? "").slice(0, 60).trim();
  return t || null;
}

/** The spelling of `topic` already in use, matched without case ("Shared notes" reuses "shared notes"). */
export function canonicalTopic(topic: string | null | undefined, existing: (string | null)[]): string | null {
  const t = normalizeTopic(topic);
  if (!t) return null;
  return existing.find((e) => e && e.toLowerCase() === t.toLowerCase()) ?? t;
}

/** Words that say what kind of question it is, not what it's about. */
const TOPIC_STOP = new Set(
  (
    "a an the and or of for to in on at by with from vs versus best top free cheap good great new how what which why where when who " +
    "is are do does can should will i me my you your near online app apps software tool tools service services company companies " +
    "review reviews alternative alternatives price prices pricing cost list guide ideas tips way ways"
  ).split(" "),
);

/** Content words of a keyword, with years and numbers dropped. */
const topicWords = (keyword: string) =>
  squash(keyword.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " "))
    .split(" ")
    .filter((w) => w.length > 1 && !TOPIC_STOP.has(w) && !/^\d+$/.test(w));

/**
 * A topic for each suggested keyword, where one is sensible: the word or word pair it shares with
 * the most other keywords, a pair winning a tie ("shared notes" for "best shared notes app" and
 * "shared notes mac"). A phrase in every keyword, or in more than half of them (from three up),
 * is too broad to group by: it is usually the product category or platform ("mac"). A topic
 * already in use wins when the keyword contains it. Null when a keyword shares nothing useful.
 */
export function suggestTopics(keywords: string[], existing: string[] = []): (string | null)[] {
  const phrases = keywords.map((k) => {
    const w = topicWords(k);
    return [...new Set([...w.slice(0, -1).map((x, i) => `${x} ${w[i + 1]}`), ...w])];
  });
  const df = new Map<string, number>();
  for (const list of phrases) for (const p of list) df.set(p, (df.get(p) ?? 0) + 1);
  const n = keywords.length;
  const tooBroad = (d: number) => (d === n && n >= 2) || (d >= 3 && d > n / 2);
  return keywords.map((k, i) => {
    const lower = ` ${squash(k.toLowerCase())} `;
    const reuse = existing.filter((e) => lower.includes(` ${e.toLowerCase()} `)).sort((a, b) => b.length - a.length)[0];
    if (reuse) return reuse;
    const best = phrases[i]
      .map((p) => ({ p, df: df.get(p)!, pair: p.includes(" ") }))
      .filter((c) => c.df >= 2 && !tooBroad(c.df))
      .sort((a, b) => b.df - a.df || Number(b.pair) - Number(a.pair) || b.p.length - a.p.length)[0];
    return best?.p ?? null;
  });
}
