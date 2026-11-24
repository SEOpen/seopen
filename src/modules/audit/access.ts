/**
 * The site audit's "Crawler and AI access" checks, run when a crawl is imported:
 *
 * 1. robots.txt, fetched live from the site: a search crawler blocked from the home page or a key
 *    page is an error; training crawlers are listed as the owner's choice and never flagged.
 * 2. A bot fetch test: the home page and the key pages, requested once as a normal visitor and once
 *    with each search crawler's user agent. A crawler answered differently from a visitor is a
 *    warning. This tests user-agent rules only: the requests come from SEOpen, not the crawlers' IPs.
 * 3. Raw vs rendered, on crawls that ran JavaScript: pages whose H1 or most of whose text appears
 *    only after rendering.
 * 4. http:// redirecting to https://, and sitemap URLs the crawl found redirecting, broken or kept
 *    out of search. A missing sitemap, missing canonicals and the www host are already audit checks.
 *
 * The detectors are pure; `checkAccess` does the fetching and never throws, so a site that won't
 * answer these requests can't fail the import.
 */
import { crawlerAccess, isTextFile, readRobots, SEARCH_CRAWLERS, TRAINING_CRAWLERS, type CrawlerRole } from "@/lib/web/crawlers";
import { fetchErrorMessage, safeFetch, SEARCH_BOT_USER_AGENTS, type FetchOptions, type FetchResult } from "@/lib/web/fetch";
import { pageFacts } from "@/lib/web/html";
import type { Robots } from "@/lib/web/robots";
import { sitemapLocs } from "@/lib/web/sitemap";
import type { CrawledPage, IssueRow } from "./issues";
import { CRAWL_USER_AGENT } from "./transform";

/** Pages besides the home page that get the robots and bot fetch checks: the most linked-to. */
export const KEY_PAGES = 4;
/** Pages fetched for the raw vs rendered comparison, most linked-to first. */
export const MAX_RENDER_CHECKS = 30;
/** A page with fewer rendered words than this isn't judged on its text, only its H1. */
export const MIN_RENDERED_WORDS = 100;
/** Raw HTML with less than this share of the rendered words counts as "most of the text needs JavaScript". */
export const RAW_TEXT_SHARE = 0.5;
const FETCH_TIMEOUT_MS = 8000;
const RENDER_BATCH = 5;
/** No new batch of raw-HTML fetches starts after this, so a slow site can't hold up the import. */
const RENDER_BUDGET_MS = 60_000;
const MAX_CHILD_SITEMAPS = 3;

/** The bot fetch test's limit, said wherever its results show. */
export const USER_AGENT_ONLY =
  "Sent from SEOpen with each crawler's user-agent string. This tests user-agent rules only, not the crawlers' IP ranges, and some firewalls treat the real crawlers differently.";

export type BotToken = keyof typeof SEARCH_BOT_USER_AGENTS;

/** What the access checks saw, kept on the crawl's summary (`audit_crawls.summary.access`) for the audit page and MCP. */
export interface AccessReport {
  checkedAt: string;
  robots: { url: string; status: number | null; fetchedAt: string; found: boolean; error: string | null; sitemaps: string[] };
  /** Search and training crawlers, as robots.txt treats the home page. */
  crawlers: { token: string; owner: string; role: CrawlerRole; does: string; allowed: boolean; rule: string | null }[];
  keyPages: string[];
  /** The bot fetch test. `baseline` is the answer a normal visitor got. */
  probes: BotProbe[];
  /** Null when the crawl didn't run JavaScript, so there's no rendered page to compare with. */
  rendered: { checked: number; flagged: number } | null;
  http: { status: number | null; finalUrl: string | null } | null;
  sitemap: { url: string; status: number | null; listed: number } | null;
}

export interface BotProbe {
  url: string;
  baseline: number | null;
  bots: { token: string; status: number | null; error?: string }[];
}

export interface RenderSample {
  url: string;
  /** From the crawl, which ran JavaScript. */
  renderedH1: boolean;
  renderedWords: number | null;
  /** From a plain fetch of the page. */
  rawH1: number;
  rawWords: number;
}

const homeOf = (target: string) => `https://${target}/`;
const isOk = (s: number | null | undefined) => s != null && s >= 200 && s < 300;
const withoutSlash = (url: string) => url.replace(/\/$/, "");

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return "/";
  }
}

/** The home page, then the HTML pages that answered 200 with the most internal links pointing in. */
export function keyPages(target: string, pages: CrawledPage[], hidden: Set<string> = new Set(), n = KEY_PAGES): string[] {
  const home = homeOf(target);
  const others = pages
    .filter((p) => p.resourceType === "html" && isOk(p.statusCode) && withoutSlash(p.url) !== withoutSlash(home) && !hidden.has(p.url))
    .sort((a, b) => (b.internalLinksIn ?? 0) - (a.internalLinksIn ?? 0) || (a.depth ?? 99) - (b.depth ?? 99) || a.url.localeCompare(b.url))
    .slice(0, n)
    .map((p) => p.url);
  return [home, ...others];
}

const list = (items: string[]) => (items.length <= 2 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** Search crawlers robots.txt keeps off each key page, one row per page. */
export function robotsFindings(robots: Robots, status: number | null, urls: string[]): IssueRow[] {
  const out: IssueRow[] = [];
  for (const url of urls) {
    const blocked = crawlerAccess(robots, pathOf(url), status, SEARCH_CRAWLERS).filter((c) => !c.allowed);
    if (!blocked.length) continue;
    // Crawlers caught by the same line read as one clause: "Googlebot and Bingbot (Disallow: /)".
    const byRule = new Map<string, string[]>();
    for (const c of blocked) byRule.set(c.rule ?? "", [...(byRule.get(c.rule ?? "") ?? []), c.token]);
    const detail = [...byRule].map(([rule, tokens]) => `${list(tokens)}${rule ? ` (${rule})` : ""}`).join("; ");
    out.push({ code: "search-bot-blocked", url, detail });
  }
  return out;
}

/** Key pages a visitor got with 2xx but some search crawler's user agent didn't. */
export function botFetchFindings(probes: BotProbe[]): IssueRow[] {
  const out: IssueRow[] = [];
  for (const p of probes) {
    if (!isOk(p.baseline)) continue;
    const turned = p.bots.filter((b) => b.status !== 200);
    if (!turned.length) continue;
    out.push({ code: "bot-turned-away", url: p.url, detail: turned.map((b) => `${b.token} ${b.status ?? "no answer"}`).join(", ") });
  }
  return out;
}

/** Pages whose H1, or most of whose text, the raw HTML lacks. */
export function renderFindings(samples: RenderSample[]): IssueRow[] {
  const out: IssueRow[] = [];
  for (const s of samples) {
    const h1 = s.renderedH1 && s.rawH1 === 0;
    const rendered = s.renderedWords ?? 0;
    const text = rendered >= MIN_RENDERED_WORDS && s.rawWords < rendered * RAW_TEXT_SHARE;
    if (!h1 && !text) continue;
    const words = rendered >= MIN_RENDERED_WORDS ? `${s.rawWords} of ${rendered} words` : null;
    const detail = [words, h1 ? "no H1" : null].filter(Boolean).join(", ");
    out.push({ code: "content-needs-javascript", url: s.url, detail });
  }
  return out;
}

/** The http:// home page answering without moving to https. */
export function httpFinding(target: string, http: AccessReport["http"]): IssueRow[] {
  if (!http || !http.finalUrl || !isOk(http.status)) return [];
  return http.finalUrl.startsWith("http://") ? [{ code: "http-not-redirected", url: homeOf(target), detail: String(http.status) }] : [];
}

/** on_page/non_indexable reasons that mean a page is kept out of search, in words. */
const HIDDEN_REASON: Record<string, string> = { meta_tag: "noindex", http_header: "noindex header", robots_txt: "blocked by robots.txt" };

/** Sitemap URLs the crawl saw redirecting, failing or kept out of search. URLs the crawl didn't reach aren't judged. */
export function sitemapFindings(listed: string[], pages: CrawledPage[], nonIndexable: { url: string; reason: string | null }[]): IssueRow[] {
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const hidden = new Map(nonIndexable.filter((n) => HIDDEN_REASON[n.reason ?? ""]).map((n) => [n.url, HIDDEN_REASON[n.reason ?? ""]]));
  const out: IssueRow[] = [];
  const seen = new Set<string>();
  for (const url of listed) {
    if (seen.has(url)) continue;
    seen.add(url);
    const p = byUrl.get(url);
    const why = hidden.get(url);
    if (why) out.push({ code: "sitemap-lists-bad-url", url, detail: why });
    else if (p && p.statusCode != null && p.statusCode >= 300 && p.statusCode < 400) out.push({ code: "sitemap-lists-bad-url", url, detail: p.location ? `${p.statusCode} → ${p.location}` : String(p.statusCode) });
    else if (p && p.statusCode != null && p.statusCode >= 400) out.push({ code: "sitemap-lists-bad-url", url, detail: String(p.statusCode) });
  }
  return out;
}

type Fetch = (url: string, options?: FetchOptions) => Promise<FetchResult>;

export interface AccessDeps {
  fetch: Fetch;
  now: () => number;
}

async function settled(work: Promise<FetchResult>): Promise<{ ok: true; value: FetchResult } | { ok: false; error: string }> {
  try {
    const value = await work;
    return value ? { ok: true, value } : { ok: false, error: "No answer." };
  } catch (err) {
    return { ok: false, error: fetchErrorMessage(err) };
  }
}

async function probe(fetch: Fetch, url: string): Promise<BotProbe> {
  const head = { headOnly: true, maxRedirects: 3, timeoutMs: FETCH_TIMEOUT_MS };
  // The visitor is a browser, as in the crawl itself: some firewalls turn away any user agent that says "bot".
  const [baseline, ...bots] = await Promise.all([
    settled(fetch(url, { ...head, userAgent: CRAWL_USER_AGENT })),
    ...(Object.keys(SEARCH_BOT_USER_AGENTS) as BotToken[]).map((token) => settled(fetch(url, { ...head, userAgent: SEARCH_BOT_USER_AGENTS[token] }))),
  ]);
  const tokens = Object.keys(SEARCH_BOT_USER_AGENTS);
  return {
    url,
    baseline: baseline.ok ? baseline.value.status : null,
    bots: bots.map((b, i) => (b.ok ? { token: tokens[i], status: b.value.status } : { token: tokens[i], status: null, error: b.error })),
  };
}

async function renderSamples(fetch: Fetch, pages: CrawledPage[], deps: AccessDeps): Promise<RenderSample[]> {
  const candidates = pages
    .filter((p) => p.resourceType === "html" && isOk(p.statusCode) && (p.h1s.length > 0 || (p.wordCount ?? 0) >= MIN_RENDERED_WORDS))
    .sort((a, b) => (b.internalLinksIn ?? 0) - (a.internalLinksIn ?? 0) || a.url.localeCompare(b.url))
    .slice(0, MAX_RENDER_CHECKS);
  const out: RenderSample[] = [];
  const started = deps.now();
  for (let i = 0; i < candidates.length; i += RENDER_BATCH) {
    if (deps.now() - started >= RENDER_BUDGET_MS) break;
    const batch = await Promise.all(
      candidates.slice(i, i + RENDER_BATCH).map(async (p) => {
        const r = await settled(fetch(p.url, { timeoutMs: FETCH_TIMEOUT_MS }));
        // A page that won't answer a plain fetch, or whose HTML was cut short, isn't judged.
        if (!r.ok || !isOk(r.value.status) || r.value.truncated) return null;
        const facts = pageFacts(r.value.body, r.value.headers);
        return { url: p.url, renderedH1: p.h1s.length > 0, renderedWords: p.wordCount, rawH1: facts.h1, rawWords: facts.words };
      }),
    );
    for (const s of batch) if (s) out.push(s);
  }
  return out;
}

/** Every `<loc>` in the site's sitemap, following one level of sitemap index. */
async function sitemapUrls(fetch: Fetch, url: string): Promise<{ status: number | null; locs: string[] }> {
  const root = await settled(fetch(url, { maxBytes: 5_000_000, timeoutMs: FETCH_TIMEOUT_MS }));
  if (!root.ok || root.value.status !== 200) return { status: root.ok ? root.value.status : null, locs: [] };
  const parsed = sitemapLocs(root.value.body);
  if (!parsed.index) return { status: 200, locs: parsed.locs };
  const children = await Promise.all(parsed.locs.slice(0, MAX_CHILD_SITEMAPS).map((u) => settled(fetch(u, { maxBytes: 5_000_000, timeoutMs: FETCH_TIMEOUT_MS }))));
  return { status: 200, locs: children.flatMap((c) => (c.ok && c.value.status === 200 ? sitemapLocs(c.value.body).locs : [])) };
}

/** Runs the access checks for a crawl. Never throws: a check that can't run is left out, and a failure leaves no report. */
export async function checkAccess(
  crawl: { id?: number; target: string; enableJavascript: boolean },
  pages: CrawledPage[],
  nonIndexable: { url: string; reason: string | null }[],
  deps: AccessDeps = { fetch: safeFetch, now: Date.now },
): Promise<{ issues: IssueRow[]; report: AccessReport | null }> {
  try {
    return await runChecks(crawl, pages, nonIndexable, deps);
  } catch (err) {
    console.error(`[audit] crawler and AI access checks for crawl ${crawl.id ?? "?"} failed`, err);
    return { issues: [], report: null };
  }
}

async function runChecks(
  crawl: { target: string; enableJavascript: boolean },
  pages: CrawledPage[],
  nonIndexable: { url: string; reason: string | null }[],
  deps: AccessDeps,
): Promise<{ issues: IssueRow[]; report: AccessReport }> {
  const { target } = crawl;
  const robotsUrl = `https://${target}/robots.txt`;
  const hidden = new Set(nonIndexable.filter((n) => HIDDEN_REASON[n.reason ?? ""]).map((n) => n.url));
  const urls = keyPages(target, pages, hidden);

  const [[robotsRes, robotsFetchedAt], httpRes, probes, samples] = await Promise.all([
    settled(deps.fetch(robotsUrl, { maxBytes: 500_000, timeoutMs: FETCH_TIMEOUT_MS })).then((r) => [r, new Date(deps.now()).toISOString()] as const),
    settled(deps.fetch(`http://${target}/`, { headOnly: true, maxRedirects: 5, timeoutMs: FETCH_TIMEOUT_MS })),
    (async () => {
      const out: BotProbe[] = [];
      // One page at a time: six requests at once is enough for someone else's server.
      for (const url of urls) out.push(await probe(deps.fetch, url));
      return out;
    })(),
    crawl.enableJavascript ? renderSamples(deps.fetch, pages, deps) : Promise.resolve(null),
  ]);
  const robotsStatus = robotsRes.ok ? robotsRes.value.status : null;
  const robots = readRobots(robotsRes.ok ? robotsRes.value : null);

  const sitemapUrl = robots.sitemaps[0] ?? `https://${target}/sitemap.xml`;
  const sitemap = await sitemapUrls(deps.fetch, sitemapUrl);
  const http = httpRes.ok ? { status: httpRes.value.status, finalUrl: httpRes.value.url } : null;

  const issues = [
    // A robots.txt that couldn't be fetched at all says nothing about what it allows.
    ...(robotsRes.ok ? robotsFindings(robots, robotsStatus, urls) : []),
    ...botFetchFindings(probes),
    ...(samples ? renderFindings(samples) : []),
    ...httpFinding(target, http),
    ...sitemapFindings(sitemap.locs, pages, nonIndexable),
  ];

  const home = crawlerAccess(robots, "/", robotsStatus, [...SEARCH_CRAWLERS, ...TRAINING_CRAWLERS]);
  const report: AccessReport = {
    checkedAt: new Date(deps.now()).toISOString(),
    robots: {
      url: robotsUrl,
      status: robotsStatus,
      fetchedAt: robotsFetchedAt,
      found: robotsRes.ok && robotsRes.value.status === 200 && isTextFile(robotsRes.value),
      error: robotsRes.ok ? null : robotsRes.error,
      sitemaps: robots.sitemaps.slice(0, 5),
    },
    crawlers: robotsRes.ok ? home.map((c) => ({ token: c.token, owner: c.owner, role: c.role, does: c.does, allowed: c.allowed, rule: c.rule })) : [],
    keyPages: urls,
    probes,
    rendered: samples ? { checked: samples.length, flagged: issues.filter((i) => i.code === "content-needs-javascript").length } : null,
    http,
    sitemap: { url: sitemapUrl, status: sitemap.status, listed: sitemap.locs.length },
  };
  return { issues, report };
}

/** The access report kept on a crawl's summary, or null for a crawl from before these checks or one where they failed. */
export function readAccessReport(summary: unknown): AccessReport | null {
  const access = (summary as { access?: unknown } | null)?.access as Partial<AccessReport> | null | undefined;
  if (!access || typeof access !== "object" || !access.robots || !Array.isArray(access.crawlers) || !Array.isArray(access.probes)) return null;
  return access as AccessReport;
}
