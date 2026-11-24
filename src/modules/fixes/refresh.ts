import { and, between, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditCrawls, auditPages, gscQueryPages, rankKeywords } from "@/db/schema";
import { creditsFor } from "@/lib/billing/gates";
import { countOf, countWord } from "@/lib/brief";
import { taskResults, TTL } from "@/lib/dataforseo/client";
import { formatDate, formatNumber } from "@/lib/format";
import { fetchErrorMessage, safeFetch } from "@/lib/web/fetch";
import { inScope, workspaceTimeZone, type ProjectScope } from "@/lib/workspace";
import { isLikelyBotQuery } from "@/modules/google/bot-queries";
import { searchConsoleSpan } from "@/modules/google/brief";
import { gscDataRange, queriesForPage } from "@/modules/google/data";
import { addDays, daysBetween, maxDate, type DateRange } from "@/modules/google/windowing";
import { load, peek, type DfsSpec } from "@/modules/keywords/dfs";
import { serpSpec, type Market } from "@/modules/keywords/requests";
import type { SerpResult } from "@/modules/keywords/types";
import {
  brandTerms,
  coverage,
  coverSearches,
  fewLinksIn,
  FEW_LINKS_IN,
  mainSearch,
  mergeSearches,
  paaQuestions,
  readPage,
  termSet,
  titleIntents,
  type Coverage,
  type CoverageLabel,
  type Heading,
  type PaaElement,
  otherLanguage,
  ownerOf,
  questionFits,
  type SearchCoverage,
  type SearchOwner,
} from "./coverage";
import { offSiteReason, onProjectDomain } from "./domain";
import { pageVariants } from "./measure";

/**
 * The "Refresh this page" panel's data, shared by `/fixes/refresh`
 * and the MCP tool `get_page_refresh`. Everything is read from stored data and one fetch of the page
 * itself, except People also ask, which comes from a saved Google results page or a priced lookup the
 * caller approves through `mayBuy`. That lookup only ever sends a keyword the project tracks or one the
 * caller typed: a search known only from Search Console is Google data, and stays here. Nothing here writes body copy: it lists searches, questions and
 * on-page checks, each with the data behind it.
 */

/** The panel's address for a page: what Fixes, Search Console Pages and Opportunities link to. */
export const refreshHref = (url: string) => `/fixes/refresh?url=${encodeURIComponent(url)}`;

/** Fixes whose page the panel helps with: they're about what a page says or ranks for. */
const REFRESH_CODES = new Set(["thin-content", "gsc-losing-clicks", "gsc-striking-distance", "gsc-low-ctr"]);
export const refreshesPage = (code: string) => REFRESH_CODES.has(code);

/** Days of Search Console data the panel reads, ending at the newest synced day. */
export const REFRESH_DAYS = 28;
const FETCH_TIMEOUT_MS = 10_000;
/** How many of each kind of task the checklist lists. */
const CHECKLIST_SEARCHES = 5;
/** A search with fewer impressions than this stays in the table but off the checklist. */
export const CHECKLIST_MIN_IMPRESSIONS = 10;
const CHECKLIST_QUESTIONS = 5;

/** The live top 10 for People also ask, kept a week. Same request as Keyword research's, so a saved one is shared. */
export function questionsSpec(keyword: string, m: Market): DfsSpec {
  return { ...serpSpec(keyword, m), ttlSeconds: TTL.week };
}

export interface PageSource {
  /** Where the page's words were read: a fetch of the live page, the latest crawl (title and H1 only), or nowhere. */
  from: "live" | "crawl" | null;
  /** When they were read: an ISO instant. */
  at: string | null;
  status: number | null;
  title: string | null;
  h1: string | null;
  headings: Heading[];
  words: number | null;
  /** Why the words are partial or missing, for the panel to say. */
  note: string | null;
}

export interface CrawlFacts {
  crawlId: number;
  /** ISO instant the crawl finished. */
  at: string | null;
  title: string | null;
  h1: string | null;
  words: number | null;
  linksIn: number | null;
  /** The median internal links in across the crawl's working HTML pages. */
  medianLinksIn: number | null;
}

export type QuestionsState =
  | { state: "no_search" }
  /** Nothing saved, and none of the page's searches is a keyword the project tracks, so there is nothing to look up until one is tracked or typed. */
  | { state: "untracked"; main: string }
  | { state: "ready"; keyword: string; at: string | null; cached: boolean; questions: { question: string; label: CoverageLabel; absent: string[]; fits: boolean }[] }
  | { state: "priced"; keyword: string; credits: number; usd: number }
  | { state: "failed"; keyword: string; error: unknown };

export interface Basic {
  id: "main_in_title" | "main_in_h1" | "title_intents" | "links_in";
  ok: boolean;
  /** One plain sentence: what was checked and what it found. */
  finding: string;
  /** Where the data came from and when. */
  evidence: string;
}

export interface ChecklistItem {
  id: string;
  task: string;
  evidence: string;
}

export interface PageRefresh {
  url: string;
  range: DateRange | null;
  /** "Search Console, Oct 18 to Nov 14, 2026", or null with no data. */
  span: string | null;
  page: PageSource;
  crawl: CrawlFacts | null;
  searches: SearchCoverage[];
  counts: Record<CoverageLabel, number>;
  main: SearchCoverage | null;
  questions: QuestionsState;
  basics: Basic[];
  checklist: ChecklistItem[];
}

export interface RefreshProject {
  domain: string;
  locationCode: number;
  languageCode: string;
}

export interface RefreshOpts {
  /** Asked only when People also ask isn't saved: may this call spend `credits`? */
  mayBuy?: (credits: number) => Promise<boolean>;
  /** A search the caller typed for People also ask, used instead of the page's own. */
  keyword?: string | null;
}

/** The page's row in the newest finished crawl that has it, with the crawl's median links in. */
export async function crawlFacts(scope: ProjectScope, url: string): Promise<CrawlFacts | null> {
  const [row] = await db
    .select({ crawlId: auditCrawls.id, at: auditCrawls.finishedAt, title: auditPages.title, h1: auditPages.h1, words: auditPages.wordCount, linksIn: auditPages.internalLinksIn })
    .from(auditPages)
    .innerJoin(auditCrawls, eq(auditCrawls.id, auditPages.crawlId))
    .where(and(eq(auditCrawls.workspaceId, scope.workspaceId), eq(auditCrawls.projectId, scope.projectId), eq(auditCrawls.status, "done"), inArray(auditPages.url, pageVariants(url))))
    .orderBy(desc(auditCrawls.finishedAt))
    .limit(1);
  if (!row) return null;
  const [median] = await db
    .select({ value: sql<number | null>`percentile_cont(0.5) within group (order by ${auditPages.internalLinksIn})::float` })
    .from(auditPages)
    .where(and(eq(auditPages.workspaceId, scope.workspaceId), eq(auditPages.crawlId, row.crawlId), eq(auditPages.resourceType, "html"), sql`${auditPages.statusCode} between 200 and 299`, sql`${auditPages.internalLinksIn} is not null`));
  return { ...row, at: row.at?.toISOString() ?? null, medianLinksIn: median?.value ?? null };
}

/** The page's searches over the last REFRESH_DAYS days of synced data, merged across its addresses. */
async function searchesFor(scope: ProjectScope, url: string, languageCode: string): Promise<{ range: DateRange | null; rows: ReturnType<typeof mergeSearches> }> {
  const data = await gscDataRange(scope);
  if (!data) return { range: null, rows: [] };
  // Not before the first synced day, so the evidence names only days with data.
  const range = { start: maxDate(addDays(data.last, -(REFRESH_DAYS - 1)), data.first), end: data.last };
  const lists = await Promise.all(pageVariants(url).map((page) => queriesForPage(scope, page, range)));
  // A rank checker's searches aren't people's, and a search in another language is another market's, so neither is anything to cover.
  return { range, rows: mergeSearches(lists).filter((r) => !isLikelyBotQuery(r.query) && !otherLanguage(r.query, languageCode)) };
}

/** Searches the refresh reads owners for: the page's top ones, which are the ones it lists and acts on. */
const OWNER_SEARCHES = 200;

/** For each of the page's searches, the other pages of the site Google showed for it over the same period, by page. */
async function otherPages(scope: ProjectScope, url: string, queries: string[], range: DateRange): Promise<Map<string, SearchOwner[]>> {
  const out = new Map<string, SearchOwner[]>();
  if (!queries.length) return out;
  const t = gscQueryPages;
  const rows = await db
    .select({ query: t.query, page: t.page, impressions: sql<number>`sum(${t.impressions})::int`, position: sql<number>`sum(${t.position} * ${t.impressions}) / nullif(sum(${t.impressions}), 0)` })
    .from(t)
    .where(and(inScope(t, scope), inArray(t.query, queries), notInArray(t.page, pageVariants(url)), between(t.date, range.start, range.end)))
    .groupBy(t.query, t.page);
  for (const r of rows) {
    if (!(r.impressions > 0)) continue;
    out.set(r.query, [...(out.get(r.query) ?? []), { page: r.page, impressions: r.impressions, position: Math.round(Number(r.position) * 10) / 10 }]);
  }
  return out;
}

/** The live page's words, or the crawl's title and H1 when it can't be read. */
async function pageSource(url: string, domain: string, crawl: CrawlFacts | null): Promise<{ source: PageSource; body: string }> {
  const fromCrawl = (note: string): { source: PageSource; body: string } =>
    crawl
      ? { source: { from: "crawl", at: crawl.at, status: null, title: crawl.title, h1: crawl.h1, headings: crawl.h1 ? [{ level: 1, text: crawl.h1 }] : [], words: crawl.words, note: `${note} Coverage is read from the latest crawl's title and H1 only, so a search the body covers may show as missing.` }, body: "" }
      : { source: { from: null, at: null, status: null, title: null, h1: null, headings: [], words: null, note: `${note} There's no crawl of it either, so nothing could be checked against the page.` }, body: "" };
  if (!onProjectDomain(url, domain)) return fromCrawl(`${url} isn't on ${domain}, so SEOpen didn't fetch it.`);
  const at = new Date().toISOString();
  try {
    const r = await safeFetch(url, { timeoutMs: FETCH_TIMEOUT_MS });
    if (r.status >= 400) return fromCrawl(`The live page answered ${r.status}.`);
    const away = offSiteReason(r, domain);
    if (away) return fromCrawl(away);
    const page = readPage(r.body);
    const h1 = page.headings.find((h) => h.level === 1)?.text ?? null;
    const note = page.jsShell ? "The page's HTML is mostly empty until JavaScript runs, so this reads only what arrives without it. Searches the rendered page covers may show as missing." : r.truncated ? "The page is over 2 MB, so only its first 2 MB were read." : null;
    return { source: { from: "live", at, status: r.status, title: page.title, h1, headings: page.headings, words: page.words, note }, body: page.body };
  } catch (err) {
    return fromCrawl(`The live page couldn't be read: ${fetchErrorMessage(err)}`);
  }
}

/** One spelling of a search: trimmed, single-spaced and lowercase, as tracked keywords are stored. */
export const searchKey = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** The keywords the project tracks now. */
async function trackedKeywords(scope: ProjectScope): Promise<Set<string>> {
  const rows = await db
    .select({ keyword: rankKeywords.keyword })
    .from(rankKeywords)
    .where(and(inScope(rankKeywords, scope), eq(rankKeywords.active, true)));
  return new Set(rows.map((r) => searchKey(r.keyword)));
}

/**
 * People also ask: saved for free, bought only when `mayBuy` says so. `own` is the search the caller typed
 * or the project tracks, and the only one that may be bought. Without it, a saved answer for the page's
 * main search is still read, since that sends nothing anywhere.
 */
async function questionsFor(own: string | null, main: string | null, market: Market, words: Set<string>, scope: ProjectScope, opts: RefreshOpts): Promise<QuestionsState> {
  const keyword = own ?? main;
  if (!keyword) return { state: "no_search" };
  const spec = questionsSpec(keyword, market);
  const shape = (result: SerpResult | null, at: Date | null, cached: boolean): QuestionsState => ({
    state: "ready",
    keyword,
    at: at?.toISOString() ?? null,
    cached,
    questions: paaQuestions(result?.items as { type: string; items?: PaaElement[] | null }[] | null).map((question) => {
      const c = coverage(question, words);
      return { question, label: c.label, absent: c.absent, fits: questionFits(question, keyword, words) };
    }),
  });
  try {
    const hit = await peek<SerpResult>(spec, scope.workspaceId);
    if (hit) return shape(taskResults(hit.res)[0] ?? null, hit.createdAt, true);
    if (!own) return { state: "untracked", main: keyword };
    const credits = creditsFor(spec.estUsd);
    if (!(await opts.mayBuy?.(credits))) return { state: "priced", keyword, credits, usd: spec.estUsd };
    const loaded = await load<SerpResult>(spec, { run: true, workspaceId: scope.workspaceId, projectId: scope.projectId });
    return loaded.state === "ready" ? shape(loaded.results[0] ?? null, loaded.fetchedAt, loaded.cached) : { state: "priced", keyword, credits, usd: spec.estUsd };
  } catch (error) {
    return { state: "failed", keyword, error };
  }
}

const pos = (n: number) => n.toFixed(1);
const quoted = (s: string) => `“${s}”`;
const searchEvidence = (s: { impressions: number; position: number }, span: string) => `${formatNumber(s.impressions)} impressions at average position ${pos(s.position)}, ${span}`;
const sourceLine = (page: PageSource) => (page.from === "live" ? "the live page" : page.from === "crawl" ? "the latest crawl" : "no copy of the page");
const onDay = (iso: string | null, timeZone: string) => (iso ? formatDate(iso, timeZone) : null);

/** On-page basics: the main search in the title and H1, a title chasing two searches, and links in from the site. */
export function basicsOf(input: { main: SearchCoverage | null; searches: SearchCoverage[]; page: PageSource; crawl: CrawlFacts | null; span: string | null; domain: string; timeZone: string }): Basic[] {
  const { main, page, crawl, span } = input;
  const out: Basic[] = [];
  const readOn = onDay(page.at, input.timeZone);
  const read = `${sourceLine(page)}${readOn ? `, read ${readOn}` : ""}`;
  if (main && span && page.from) {
    const evidence = `Main search ${quoted(main.query)}: ${searchEvidence(main, span)}. Page from ${read}.`;
    const inTitle: Coverage = coverage(main.query, termSet(page.title));
    out.push({
      id: "main_in_title",
      ok: inTitle.label === "covered",
      finding: !page.title ? "The page has no title." : inTitle.label === "covered" ? `The title has every word of ${quoted(main.query)}.` : `The title is missing ${inTitle.absent.map(quoted).join(", ")} from ${quoted(main.query)}.`,
      evidence,
    });
    const inH1 = coverage(main.query, termSet(page.h1));
    out.push({
      id: "main_in_h1",
      ok: inH1.label === "covered",
      finding: !page.h1 ? "The page has no H1." : inH1.label === "covered" ? `The H1 has every word of ${quoted(main.query)}.` : `The H1 is missing ${inH1.absent.map(quoted).join(", ")} from ${quoted(main.query)}.`,
      evidence,
    });
  }
  if (span && page.title) {
    const pair = titleIntents(page.title, input.searches, brandTerms(input.domain));
    out.push({
      id: "title_intents",
      ok: !pair,
      finding: pair ? `The title chases ${quoted(pair[0].query)} and ${quoted(pair[1].query)}, which share no words. A title aimed at one of them, with the other on its own page or lower on this one, may do better for both.` : "The title doesn't chase two unrelated searches among the page's top 10.",
      evidence: pair ? `${quoted(pair[0].query)}: ${searchEvidence(pair[0], span)}. ${quoted(pair[1].query)}: ${searchEvidence(pair[1], span)}.` : `The page's top 10 searches, ${span}, against the title from ${read}.`,
    });
  }
  if (crawl && crawl.linksIn != null) {
    const few = fewLinksIn(crawl.linksIn, crawl.medianLinksIn);
    const median = crawl.medianLinksIn == null ? "" : `, where the site's typical page gets ${formatNumber(Math.round(crawl.medianLinksIn))}`;
    const belowTypical = crawl.medianLinksIn != null && crawl.linksIn < crawl.medianLinksIn;
    const rule = few ? ` Under ${FEW_LINKS_IN} reads as few.` : belowTypical ? ` That's fewer than the typical page, but only under ${FEW_LINKS_IN} reads as few, so it isn't flagged.` : "";
    out.push({
      id: "links_in",
      ok: !few,
      finding: `${formatNumber(crawl.linksIn)} internal ${crawl.linksIn === 1 ? "link points" : "links point"} to this page${median}.${rule}`,
      evidence: `Site audit crawl${crawl.at ? ` finished ${onDay(crawl.at, input.timeZone)}` : ""}.`,
    });
  }
  return out;
}

/** The panel's tasks, each with the data behind it. Suggested headings and questions only, never copy. */
export function checklistOf(input: { searches: SearchCoverage[]; questions: QuestionsState; basics: Basic[]; span: string | null; timeZone: string }): ChecklistItem[] {
  const { span } = input;
  const out: ChecklistItem[] = [];
  if (span) {
    // A search another page owns is that page's to cover, so it's no task here.
    const worth = input.searches.filter((r) => r.impressions >= CHECKLIST_MIN_IMPRESSIONS && !r.ownedBy);
    for (const s of worth.filter((r) => r.label === "missing").slice(0, CHECKLIST_SEARCHES)) {
      out.push({ id: `search:${s.query}`, task: `Cover ${quoted(s.query)}: a section or heading that answers it, if it fits the page.`, evidence: `${searchEvidence(s, span)}. Not on the page.` });
    }
    for (const s of worth.filter((r) => r.label === "partly").slice(0, CHECKLIST_SEARCHES)) {
      out.push({ id: `words:${s.query}`, task: `Use ${s.absent.map(quoted).join(", ")} where it reads naturally, for ${quoted(s.query)}.`, evidence: `${searchEvidence(s, span)}. The page has ${s.found.map(quoted).join(", ")}.` });
    }
  }
  if (input.questions.state === "ready") {
    const q = input.questions;
    // A question that strays from the page ("Is buying backlinks illegal?" on a backlink checker) is another page's to answer.
    for (const item of q.questions.filter((x) => x.label !== "covered" && x.fits).slice(0, CHECKLIST_QUESTIONS)) {
      out.push({ id: `question:${item.question}`, task: `Answer ${quoted(item.question)} on the page.`, evidence: `People also ask for ${quoted(q.keyword)}, Google results from ${onDay(q.at, input.timeZone) ?? "a saved lookup"}.` });
    }
  }
  const tasks: Record<Basic["id"], string> = {
    main_in_title: "Put the main search in the title.",
    main_in_h1: "Put the main search in the H1.",
    title_intents: "Aim the title at one search.",
    links_in: "Link to this page from related pages on the site.",
  };
  for (const b of input.basics.filter((x) => !x.ok)) out.push({ id: b.id, task: tasks[b.id], evidence: `${b.finding} ${b.evidence}` });
  return out;
}

/** Everything the panel shows for one page. */
export async function pageRefresh(scope: ProjectScope, project: RefreshProject, url: string, opts: RefreshOpts = {}): Promise<PageRefresh> {
  const [crawl, gsc, timeZone] = await Promise.all([crawlFacts(scope, url), searchesFor(scope, url, project.languageCode), workspaceTimeZone(scope)]);
  const { source: page, body } = await pageSource(url, project.domain, crawl);
  const words = termSet(page.title, ...page.headings.map((h) => h.text), body);
  const others = gsc.range ? await otherPages(scope, url, gsc.rows.slice(0, OWNER_SEARCHES).map((r) => r.query), gsc.range) : new Map<string, SearchOwner[]>();
  const searches = (page.from ? coverSearches(gsc.rows, words) : []).map((s) => {
    const owner = ownerOf(s, others.get(s.query) ?? []);
    return owner ? { ...s, ownedBy: owner } : s;
  });
  const counts = { covered: 0, partly: 0, missing: 0 };
  for (const s of searches) counts[s.label]++;
  // The main search is one this page leads for, when it leads for any, and one its title or H1 is written for, when one is.
  const own = searches.filter((s) => !s.ownedBy);
  const leads = own.length ? own : searches;
  const main = mainSearch(leads, brandTerms(project.domain), termSet(page.title, page.h1));
  const span = gsc.range ? searchConsoleSpan(gsc.range) : null;
  const typed = searchKey(opts.keyword ?? "");
  const tracked = typed ? new Set<string>() : await trackedKeywords(scope);
  // Chosen as the main search is, so it's the main search itself whenever that one is tracked.
  const trackedMain = mainSearch(leads.filter((s) => tracked.has(searchKey(s.query))), brandTerms(project.domain), termSet(page.title, page.h1));
  const lookup = typed || (trackedMain ? searchKey(trackedMain.query) : null);
  const questions = page.from ? await questionsFor(lookup, main?.query ?? null, { locationCode: project.locationCode, languageCode: project.languageCode }, words, scope, opts) : { state: "no_search" as const };
  const basics = basicsOf({ main, searches, page, crawl, span, domain: project.domain, timeZone });
  return { url, range: gsc.range, span, page, crawl, searches, counts, main, questions, basics, checklist: checklistOf({ searches, questions, basics, span, timeZone }) };
}

/** The panel's opening sentence, from its data. */
export function refreshSentence(r: Pick<PageRefresh, "range" | "page" | "searches" | "counts">): string {
  if (!r.range) return "Search Console has no data for this project yet, so there are no searches to check this page against.";
  if (!r.page.from) return "SEOpen couldn't read this page, so its searches can't be checked against it.";
  // Fewer than REFRESH_DAYS when Search Console data starts inside them.
  const days = daysBetween(r.range.start, r.range.end) + 1;
  const last = days === 1 ? "in the last day" : `in the last ${days} days`;
  if (!r.searches.length) return `This page had no Search Console impressions ${last}.`;
  const shown = `This page showed for ${countOf(r.searches.length, "search", "searches")} ${last}`;
  const { missing, partly } = r.counts;
  if (!missing && !partly) return `${shown}, and its text covers every one.`;
  const parts = [missing ? `${countWord(missing)} ${missing === 1 ? "isn't" : "aren't"} on the page` : null, partly ? `${countWord(partly)} ${partly === 1 ? "is" : "are"} partly covered` : null].filter(Boolean);
  return `${shown}: ${parts.join(" and ")}.`;
}
