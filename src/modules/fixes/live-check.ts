import type { FixLiveCheck, FixSnapshot } from "@/db/schema/fixes";
import { imageAltCounts } from "@/modules/audit/image-alt";
import { headOf, titleAndDescriptionCounts } from "@/modules/audit/meta-tags";
import { crawlerAccess, readRobots, SEARCH_CRAWLERS } from "@/lib/web/crawlers";
import { attributes, decodeEntities, elements, openTags, pageFacts, stripTags, visibleText } from "@/lib/web/html";
import { RAW_TEXT_SHARE } from "@/modules/audit/access";
import { sitemapLocs } from "@/lib/web/sitemap";
import { expectedText, isGscCode, MANUAL_CODE, pathOf } from "./catalog";

/**
 * Whether a fix reached the live page, from what a fetch of that page returned. Pure: `ops.ts`
 * does the fetching. It reads raw HTML, as a crawler that doesn't run JavaScript would, so a check
 * it can't honestly make answers `cannot_check` rather than guessing.
 */

export type LiveState = FixLiveCheck["state"];

export interface LivePage {
  status: number;
  html: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Title limits. The audit's flags come from DataForSEO's title_too_long and title_too_short, whose
 * exact limits aren't documented in docs/dataforseo.md, so these follow the advice the audit gives
 * (30 to 60 characters) with room for a title just over. The next crawl has the last word.
 */
const TITLE_MAX = 65;
const TITLE_MIN = 30;

const fixed = (saw: string) => ({ state: "fixed" as const, saw });
const still = (saw: string) => ({ state: "still_there" as const, saw });
const cannot = (saw: string) => ({ state: "cannot_check" as const, saw });


/** The first H1's text, tags and spacing taken out. */
export function firstH1(html: string): string | null {
  const h1 = elements(html, ["h1"], 1)[0];
  return h1 ? decodeEntities(stripTags(h1.inner)).replace(/\s+/g, " ").trim() || null : null;
}

/** What a page says now, to compare with after the fix. */
export function snapshotOf(html: string, from: FixSnapshot["from"]): FixSnapshot {
  const facts = pageFacts(html);
  return { title: facts.title, description: facts.description, words: facts.words, h1: firstH1(html), from };
}

/** Lower case with runs of space made one, so "New  Title" on the page matches "new title". */
const loose = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * A logged change (`MANUAL_CODE`). With `expect`, it's on the page once the page's title, meta
 * description or visible text contains it. Without, once the title, meta description or H1 differs
 * from the page as it was when the change was logged.
 */
function manualCheck(page: LivePage, before: FixSnapshot | null, expect: string | null) {
  const facts = pageFacts(page.html, page.headers);
  if (expect) {
    const text = loose([facts.title ?? "", facts.description ?? "", visibleText(page.html)].join(" "));
    if (text.includes(loose(expect))) return fixed(`The page contains “${expect}”.`);
    if (facts.jsShell) return cannot("This page needs JavaScript to show its content, so a plain fetch can't see it.");
    return still(`The page doesn't contain “${expect}” yet.`);
  }
  if (!before?.from) return cannot("There's no earlier copy of this page to compare with.");
  const h1 = firstH1(page.html);
  if (facts.title !== before.title) return fixed(`The title changed to “${facts.title ?? ""}”.`);
  if (facts.description !== before.description) return fixed("The meta description changed.");
  // A snapshot from before H1s were kept has none to compare with.
  if (before.h1 !== undefined && h1 !== before.h1) return fixed(`The H1 changed to “${h1 ?? ""}”.`);
  return still("The title, meta description and H1 are the same as when the change was logged.");
}

/** A path without its trailing slashes. A loop, because `/\/+$/` takes quadratic time on a long run of slashes in the middle. */
function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end--;
  return path.slice(0, end);
}

/** One address with or without www, http and a trailing slash, query and fragment dropped. */
function samePage(a: URL, b: URL): boolean {
  const host = (u: URL) => u.hostname.replace(/^www\./, "");
  const path = (u: URL) => (u.pathname.length > 1 ? withoutTrailingSlashes(u.pathname) : "/");
  return host(a) === host(b) && path(a) === path(b);
}

/** Whether a page's HTML has an `<a href>` to the target, relative links read against the page. */
export function linksTo(html: string, pageUrl: string, target: string): boolean {
  const to = new URL(target);
  return openTags(html, "a").some((tag) => {
    const href = attributes(tag.raw).href;
    if (!href || /^(mailto|tel|javascript):/i.test(href)) return false;
    try {
      return samePage(new URL(href, pageUrl), to);
    } catch {
      return false;
    }
  });
}

/** What a fetch of one linking page returned, or why there's nothing to read. */
export type LinkSource = { url: string; page: LivePage } | { url: string; error: string };

/**
 * A logged change that added links to a page from others (`linked_from`): live once every one of
 * them links to it in its raw HTML. A page that can't be read, or needs JavaScript, can't be judged.
 */
export function linksCheck(target: string, sources: LinkSource[]): { state: LiveState; saw: string } {
  const missing: string[] = [];
  const unread: string[] = [];
  for (const s of sources) {
    if ("error" in s || s.page.status >= 400) unread.push(pathOf(s.url));
    else if (linksTo(s.page.html, s.url, target)) continue;
    else if (pageFacts(s.page.html, s.page.headers).jsShell) unread.push(pathOf(s.url));
    else missing.push(pathOf(s.url));
  }
  const to = pathOf(target);
  const n = sources.length;
  const pages = (k: number) => `${k} ${k === 1 ? "page" : "pages"}`;
  if (missing.length) return still(`${n - missing.length} of ${pages(n)} link to ${to}. Not yet: ${missing.join(", ")}.`);
  if (unread.length) return cannot(`SEOpen couldn't read ${unread.join(", ")} without JavaScript or at all, so it can't tell whether ${unread.length === 1 ? "it links" : "they link"} to ${to}.`);
  return fixed(n === 1 ? `${pathOf(sources[0].url)} links to ${to}.` : `All ${n} pages link to ${to}.`);
}

/** The address to fetch: a site-wide file, or the page. */
export function checkTarget(code: string, url: string): string {
  const file = code === "no-sitemap" || code === "sitemap-lists-bad-url" ? "/sitemap.xml" : code === "no-robots-txt" || code === "search-bot-blocked" ? "/robots.txt" : null;
  return file ? new URL(file, url).href : url;
}

/** A finding whose fix is new wording: it's on the page once that wording differs from before. */
function changedSince(page: LivePage, before: FixSnapshot | null, only?: "title" | "description") {
  const now = snapshotOf(page.html, null);
  if (!before?.from) return cannot("There's no earlier copy of this page to compare with.");
  if (only !== "description" && now.title !== before.title) return fixed(`The title changed to “${now.title ?? ""}”.`);
  if (only !== "title" && now.description !== before.description) return fixed("The meta description changed.");
  return still(only ? `The ${only === "title" ? "title" : "meta description"} is the same as before the fix.` : "The title and description are the same as before the fix.");
}

/** A finding whose fix may be anywhere on the page: an unchanged title proves nothing, so it can't fail on one. */
function contentChangedSince(page: LivePage, before: FixSnapshot | null) {
  const check = changedSince(page, before);
  if (check.state !== "still_there") return check;
  const words = pageFacts(page.html).words;
  if (before?.words != null && words !== before.words) return fixed(`The page went from ${before.words} words to ${words}.`);
  return cannot("The title, description and word count haven't changed. If the change was elsewhere on the page, the numbers will show it.");
}

/** The first link in an audit detail, which reads "https://x (+2 more)" when a page has several. */
/**
 * Whether the page opens with a doctype, after any whitespace and comments. Read with indexOf: the
 * regex `^\s*(<!--[\s\S]*?-->\s*)*<!doctype` backtracks exponentially over leading comments when
 * there's no doctype, so 28 of them took a second and each two more four times as long.
 */
function startsWithDoctype(html: string): boolean {
  const space = /\s*/y;
  let at = 0;
  for (;;) {
    space.lastIndex = at;
    space.exec(html);
    at = space.lastIndex;
    if (!html.startsWith("<!--", at)) break;
    const close = html.indexOf("-->", at + 4);
    if (close < 0) return false;
    at = close + 3;
  }
  return /<!doctype\s+html/iy.test(html.slice(at, at + 64));
}

/** An opening tag named `name` whose own text matches `re`, scanned in linear time. */
const hasTag = (html: string, name: string, re: RegExp) => openTags(html, name).some((t) => re.test(t.raw));

/** A body that's a web page: what a site answering every path with its home or error page returns. */
function isWebPage(page: LivePage): boolean {
  const type = page.headers["content-type"];
  if (/html/i.test(String(Array.isArray(type) ? type[0] : (type ?? "")))) return true;
  return /^\s*(<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(page.html.slice(0, 1000));
}

/**
 * A site-wide file is there once it answers 200 with what it should hold: any 200 isn't enough, as
 * many sites answer a missing path with their home page.
 */
function fileCheck(code: "no-sitemap" | "no-robots-txt", page: LivePage) {
  if (page.status !== 200) return still(`It answers with ${page.status}.`);
  if (code === "no-sitemap") {
    return /<(urlset|sitemapindex)\b/i.test(page.html.slice(0, 5000)) ? fixed("It answers with 200 and lists URLs.") : still("It answers with 200, but what it returns isn't a sitemap.");
  }
  // An empty robots.txt is valid: it allows everything.
  return isWebPage(page) ? still("It answers with 200, but with a web page, not a robots.txt.") : fixed("It answers with 200 and a text file.");
}

const linkTarget = (detail: string) => detail.replace(/ \(\+\d+ more\)$/, "");

/** robots.txt, fetched again: whether every search crawler may now fetch the page the finding named. */
function robotsCheck(url: string, page: LivePage) {
  const path = pathOf(url);
  if (page.status >= 500) return still(`robots.txt answers with ${page.status}, which crawlers read as keep out.`);
  const blocked = crawlerAccess(readRobots({ status: page.status, headers: page.headers, body: page.html }), path, page.status, SEARCH_CRAWLERS).filter((c) => !c.allowed);
  return blocked.length ? still(`robots.txt still blocks ${blocked.map((c) => c.token).join(", ")} from ${path}.`) : fixed(`robots.txt lets every search crawler fetch ${path}.`);
}

/** The sitemap, fetched again: whether it still lists the URL. An index's files aren't fetched, so the next crawl says. */
function sitemapCheck(url: string, page: LivePage) {
  if (page.status !== 200) return cannot(`The sitemap answers with ${page.status}.`);
  const { index, locs } = sitemapLocs(page.html);
  if (index) return cannot("The sitemap is an index of other sitemaps, so the next crawl will check its files.");
  return locs.includes(url) ? still("The sitemap still lists this URL.") : fixed("The sitemap no longer lists this URL.");
}

/** The raw HTML against what the crawl saw rendered, from the finding's detail ("12 of 900 words, no H1"). */
function rawHtmlCheck(detail: string | null, page: LivePage) {
  const facts = pageFacts(page.html, page.headers);
  const words = /(\d+) of (\d+) words/.exec(detail ?? "");
  const needsH1 = /no H1/.test(detail ?? "");
  if (!words && !needsH1) return cannot("The audit didn't record what was missing.");
  if (needsH1 && facts.h1 === 0) return still("The HTML still has no h1 before JavaScript runs.");
  const rendered = words ? Number(words[2]) : 0;
  if (words && facts.words < rendered * RAW_TEXT_SHARE) return still(`The HTML has ${facts.words} words before JavaScript runs; the crawl saw ${rendered} after.`);
  return fixed(words ? `The HTML has ${facts.words} words${needsH1 ? " and an h1" : ""} before JavaScript runs.` : "The HTML has an h1 before JavaScript runs.");
}

export function liveCheck(fix: { code: string; detail: string | null; url?: string; evidence?: Record<string, unknown> | null }, page: LivePage, before: FixSnapshot | null): { state: LiveState; saw: string } {
  const { code, detail } = fix;
  // These look for a file: a missing one is the finding, not a broken page.
  if (code === "no-sitemap" || code === "no-robots-txt") return fileCheck(code, page);
  if (code === "search-bot-blocked") return fix.url ? robotsCheck(fix.url, page) : cannot("The finding didn't record which page.");
  if (code === "sitemap-lists-bad-url") return fix.url ? sitemapCheck(fix.url, page) : cannot("The finding didn't record which URL.");
  if (code === "http-4xx" || code === "http-5xx" || code === "unreachable" || code === "broken-resources") return page.status < 400 ? fixed(`The page answers with ${page.status}.`) : still(`The page answers with ${page.status}.`);
  if (page.status >= 400) return { state: "page_broken", saw: `The page answers with ${page.status}.` };

  const facts = pageFacts(page.html, page.headers);
  const title = facts.title ?? "";
  // An app shell has its content in JavaScript, which this fetch doesn't run.
  const inBody = () => (facts.jsShell ? cannot("This page needs JavaScript to show its content, so a plain fetch can't see it.") : null);

  switch (code) {
    case "missing-title":
      return title ? fixed(`The title is “${title}”.`) : still("The page still has no title.");
    case "title-too-long":
      return title.length && title.length <= TITLE_MAX ? fixed(`The title is ${title.length} characters.`) : still(`The title is ${title.length} characters.`);
    case "title-too-short":
      return title.length >= TITLE_MIN ? fixed(`The title is ${title.length} characters.`) : still(`The title is ${title.length} characters.`);
    case "missing-description":
      return facts.description ? fixed("The page has a meta description.") : still("The page still has no meta description.");
    case "duplicate-title":
      return changedSince(page, before, "title");
    case "duplicate-description":
      return changedSince(page, before, "description");
    case "duplicate-meta-tags": {
      const { titles, descriptions } = titleAndDescriptionCounts(page.html);
      return titles <= 1 && descriptions <= 1 ? fixed("The page has one of each tag.") : still(`The page has ${titles} titles and ${descriptions} meta descriptions.`);
    }
    case "missing-h1":
      return inBody() ?? (facts.h1 >= 1 ? fixed("The page has an h1.") : still("The page still has no h1."));
    case "multiple-h1":
      return inBody() ?? (facts.h1 === 1 ? fixed("The page has one h1.") : still(`The page has ${facts.h1} h1s.`));
    case "missing-canonical":
      return facts.canonical ? fixed(`The canonical is ${facts.canonical}.`) : still("The page still has no canonical.");
    case "canonical-to-broken":
    case "canonical-loop":
    case "canonical-to-redirect":
      return !detail ? cannot("The audit didn't record the old canonical.") : facts.canonical !== detail ? fixed(`The canonical is now ${facts.canonical ?? "gone"}.`) : still(`The canonical is still ${detail}.`);
    case "non-indexable":
    case "gsc-not-indexed":
      if (facts.robots.some((d) => d === "noindex" || d === "none")) return still("The page still says noindex.");
      return code === "non-indexable" ? fixed("The page no longer says noindex.") : cannot("The page has no noindex. Only Google can say whether it's indexed now.");
    case "structured-data-errors":
      return facts.jsonLdErrors === 0 ? fixed(`All ${facts.jsonLdBlocks} JSON-LD blocks parse.`) : still(`${facts.jsonLdErrors} JSON-LD blocks don't parse.`);
    case "broken-internal-links":
    case "broken-external-links": {
      if (!detail) return cannot("The audit didn't record which link.");
      const target = linkTarget(detail);
      return inBody() ?? (page.html.includes(`"${target}"`) || page.html.includes(`'${target}'`) ? still(`The page still links to ${target}.`) : detail !== target ? cannot(`The page no longer links to ${target}, and the next crawl will check its other broken links.`) : fixed(`The page no longer links to ${target}.`));
    }
    case "links-to-http":
      return inBody() ?? (hasTag(page.html, "a", /\shref=["']http:\/\//i) ? still("The page still has an http link.") : fixed("The page has no http links."));
    case "meta-refresh":
      return hasTag(page.html, "meta", /\shttp-equiv=["']?refresh/i) ? still("The page still has a meta refresh.") : fixed("The page has no meta refresh.");
    case "no-doctype":
      return startsWithDoctype(page.html) ? fixed("The page starts with a doctype.") : still("The page has no doctype.");
    case "no-charset":
      return hasTag(headOf(page.html), "meta", /\scharset=/i) ? fixed("The page declares its charset.") : still("The page doesn't declare its charset.");
    case "missing-alt": {
      if (inBody()) return inBody()!;
      const { missing } = imageAltCounts(page.html);
      return missing ? still(`${missing} images have no alt attribute.`) : fixed("Every image has an alt attribute.");
    }
    case "content-needs-javascript":
      return rawHtmlCheck(detail, page);
    case MANUAL_CODE:
      return manualCheck(page, before, expectedText(fix.evidence));
    case "no-favicon":
      return hasTag(headOf(page.html), "link", /\srel=["'][^"']*icon/i) ? fixed("The page names a favicon.") : cannot("The page names no favicon, but one may be at /favicon.ico.");
    default:
      if (code === "gsc-low-ctr") return changedSince(page, before);
      return isGscCode(code) ? contentChangedSince(page, before) : cannot("SEOpen can't check this one from the page alone. The next crawl will.");
  }
}
