import { ISSUES } from "@/modules/audit/taxonomy";
import { formatShortDate } from "@/lib/format";
import { rules } from "@/plan-policy/rules";
import type { SerpType } from "@/modules/content-briefs/types";
import { NOUN } from "./page-type";
import { similarMatch } from "./pairs";

/**
 * What each finding means as a fix: who can act on it, what to change and what to expect. Data and
 * pure functions only, so the app, the MCP tools and the jobs read the same words. The proposed
 * change is a rule, never written by a model on the server: the customer's agent does the writing
 *. Expected effects stay qualitative, because SEOpen only claims
 * numbers it has measured.
 */

/** code: an agent can change it in the repo. content: it needs writing or a decision. hosting: it's outside the repo. */
export type FixKind = "code" | "content" | "hosting";

export type GscCode = "gsc-low-ctr" | "gsc-losing-clicks" | "gsc-striking-distance" | "gsc-not-indexed" | "gsc-split-query" | "gsc-shown-not-ranking" | "gsc-wrong-page-type";

/** Findings measured from Search Console, not a crawl. */
export const GSC_CODES: readonly GscCode[] = ["gsc-low-ctr", "gsc-losing-clicks", "gsc-striking-distance", "gsc-not-indexed", "gsc-split-query", "gsc-shown-not-ranking", "gsc-wrong-page-type"];

export const isGscCode = (code: string): code is GscCode => (GSC_CODES as readonly string[]).includes(code);

export interface FixDef {
  kind: FixKind;
  /** How a result line counts these: "Fixed 12 titles". */
  noun: [one: string, many: string];
  /** The result line's verb, when "Fixed" isn't true: "Changed 5 pages". */
  verb?: string;
  /** What to change, when it can say more than the audit's general advice. The agent's words. */
  proposed?: string;
  /** The same advice for the customer, when `proposed` tells an agent what to do about them. */
  forPeople?: string;
  /** What should follow, in words SEOpen can later check. */
  effect: string;
}

const TITLE: FixDef["noun"] = ["title", "titles"];
const DESCRIPTION: FixDef["noun"] = ["description", "descriptions"];
const CANONICAL: FixDef["noun"] = ["canonical tag", "canonical tags"];
const HEADING: FixDef["noun"] = ["heading", "headings"];
const LINK: FixDef["noun"] = ["broken link", "broken links"];
const PAGE: FixDef["noun"] = ["page", "pages"];
const ISSUE: FixDef["noun"] = ["issue", "issues"];

const SNIPPET = "Google shows the page with wording you chose, which can bring more clicks from the same impressions.";
const INDEX = "Google can pick the right page to index once it next crawls this one.";

/**
 * Audit issues worth a fix record. An issue that isn't here stays on the Site audit page but makes
 * no record: it's rarely worth an agent's time (a long URL) or it can't be checked afterwards.
 */
const AUDIT_FIXES: Record<string, FixDef> = {
  "missing-title": { kind: "code", noun: TITLE, proposed: "Add a <title> of about 30 to 60 characters that says what this page is. Use the words people search for (`search_console.top_queries`).", effect: SNIPPET },
  "title-too-long": { kind: "code", noun: TITLE, proposed: "Shorten the title to about 60 characters with the important words first. Keep the words people already find this page with (`search_console.top_queries`).", effect: "The whole title shows in search results instead of being cut off." },
  "title-too-short": { kind: "code", noun: TITLE, proposed: "Lengthen the title to at least 30 characters by saying what the page offers, using the words people search for.", effect: SNIPPET },
  "duplicate-title": { kind: "code", noun: TITLE, proposed: "Give this page its own title that says how it differs from the pages sharing this one. If they're generated from one template, fix the template.", effect: "Google can tell the pages apart, and each can rank for its own searches." },
  "missing-description": { kind: "code", noun: DESCRIPTION, proposed: "Add a meta description of about 120 to 155 characters that answers what someone searching for this page wants to know.", effect: SNIPPET },
  "duplicate-description": { kind: "code", noun: DESCRIPTION, proposed: "Give this page its own meta description. If they're generated from one template, fix the template.", effect: SNIPPET },
  "duplicate-meta-tags": { kind: "code", noun: ["duplicate tag", "duplicate tags"], proposed: "Keep one of each tag. This usually means a layout and a page both set it, so remove it from the one that shouldn't.", effect: "Google reads the tag you meant it to." },
  "missing-h1": { kind: "code", noun: HEADING, proposed: "Add one <h1> that says what the page is, in the page's own component rather than the layout.", effect: "The page's main topic is clear to search engines and screen readers." },
  "multiple-h1": { kind: "code", noun: HEADING, proposed: "Keep the <h1> that names the page and make the others <h2>. Change the element, not how it looks.", effect: "The page's main topic is clear to search engines and screen readers." },
  "missing-canonical": { kind: "code", noun: CANONICAL, proposed: "Add a self-referencing canonical with the page's full https address, set once for the whole site if the framework allows it.", effect: INDEX },
  "canonical-to-broken": { kind: "code", noun: CANONICAL, proposed: "Point the canonical at this page's own working address, or at the working page it duplicates.", effect: INDEX },
  "canonical-loop": { kind: "code", noun: CANONICAL, proposed: "Make the canonical point at the final page rather than back through a chain.", effect: INDEX },
  "canonical-to-redirect": { kind: "code", noun: CANONICAL, proposed: "Point the canonical at the address the redirect ends on.", effect: INDEX },
  "non-indexable": { kind: "code", noun: PAGE, proposed: "Check whether this page should be in Google. If it should, remove the noindex or the rule blocking it. If it's meant to stay out, dismiss this fix.", effect: "Google can index the page once it next crawls it." },
  "structured-data-errors": { kind: "code", noun: ["schema error", "schema errors"], proposed: "Fix the JSON-LD so it parses and only states what's visible on the page.", effect: "The page stays eligible for rich results." },
  "broken-internal-links": { kind: "code", noun: LINK, proposed: "Change the link to the page's current address, or remove it if the page is gone.", effect: "Visitors and crawlers stop hitting a dead end." },
  "broken-external-links": { kind: "code", noun: LINK, proposed: "Change the link to the current address, or remove it.", effect: "Visitors stop hitting a dead end." },
  "broken-resources": { kind: "code", noun: ["broken file", "broken files"], proposed: "Fix or remove the reference to this image, script or stylesheet.", effect: "The page loads everything it asks for." },
  "links-to-http": { kind: "code", noun: ["http link", "http links"], proposed: "Change the link to https.", effect: "Visitors stay on a secure connection." },
  "links-to-redirects": { kind: "code", noun: ["redirected link", "redirected links"], proposed: "Link straight to the address the redirect ends on.", effect: "Crawlers and visitors take one less hop." },
  "meta-refresh": { kind: "code", noun: ISSUE, proposed: "Replace the meta refresh with a server-side 301 redirect.", effect: "Search engines pass the page's standing to the new address." },
  "no-doctype": { kind: "code", noun: ISSUE, proposed: "Add <!doctype html> as the first line of the document.", effect: "Browsers render the page in standards mode." },
  "no-charset": { kind: "code", noun: ISSUE, proposed: 'Add <meta charset="utf-8"> at the top of the <head>.', effect: "Text displays correctly everywhere." },
  "missing-alt": { kind: "code", noun: ["image", "images"], proposed: 'Add an alt attribute to each image named. Describe the images that carry meaning, and give decorative ones alt="".', effect: "Images can show in image search, and screen readers can describe them." },
  "placeholder-text": { kind: "code", noun: ISSUE, proposed: "Replace the placeholder with real wording. Ask the user if the real wording isn't in the repo.", forPeople: "Replace the placeholder with your real wording.", effect: "The page stops looking unfinished to visitors and Google." },
  "no-sitemap": { kind: "code", noun: ["sitemap", "sitemaps"], proposed: "Add a sitemap listing the pages that should be indexed, generated from the routes if the framework allows it.", effect: "Google finds new and changed pages sooner." },
  "no-robots-txt": { kind: "code", noun: ["robots.txt", "robots.txt"], proposed: "Add a robots.txt that allows crawling and names the sitemap.", effect: "Crawlers get a clear answer and can find the sitemap." },
  "search-bot-blocked": {
    kind: "code",
    noun: ["robots.txt rule", "robots.txt rules"],
    proposed: "Change robots.txt so the search crawlers named in `detail` may fetch this page: remove the Disallow rule that catches them, or add a group naming each one with \"Allow: /\". Leave training crawlers (GPTBot, ClaudeBot, Google-Extended, CCBot) as the user set them. If robots.txt answers with a server error, fix whatever serves it.",
    forPeople: "Change robots.txt so these search crawlers may fetch this page: remove the Disallow rule that catches them, or add a group naming each one with \"Allow: /\". Blocking training crawlers such as GPTBot is your choice and can stay.",
    effect: "The search crawlers named can fetch the page again, so their engines can show and cite it.",
  },
  "content-needs-javascript": { kind: "code", noun: PAGE, proposed: "Render this page's H1 and main text on the server (server-side rendering or static generation) so they're in the HTML before any script runs. Keep client-side code for what's interactive.", effect: "Crawlers that don't run JavaScript can read the page's heading and text." },
  "sitemap-lists-bad-url": { kind: "code", noun: ["sitemap entry", "sitemap entries"], proposed: "Take this URL out of the sitemap, or list the address it redirects to instead. Change whatever generates the sitemap rather than its output.", effect: "The sitemap lists only pages Google can index." },
  "no-favicon": { kind: "code", noun: ["favicon", "favicons"], proposed: "Add a favicon of at least 48 by 48 pixels.", effect: "Google can show the site's icon beside its results." },
  "thin-content": { kind: "content", noun: PAGE, proposed: "Say more that's useful on this page, or merge it into one that does. Answer the searches it already shows for (`search_console.top_queries`) first. Don't pad it: ask the user what's true before writing.", forPeople: "Say more that's useful on this page, or merge it into one that does. Add what's true for your business rather than padding it.", effect: "The page has enough on it to rank for what it's about." },
  "duplicate-content": { kind: "content", noun: PAGE, proposed: "Make the pages say different things, or redirect one to the other and keep the better one.", effect: "Google stops choosing between them." },
  "orphan-page": { kind: "content", noun: PAGE, proposed: "Link to this page from a related page, or remove it if it shouldn't exist.", effect: "Crawlers and visitors can reach the page." },
  "http-5xx": { kind: "hosting", noun: PAGE, effect: "The page answers again, and Google keeps it indexed." },
  "http-4xx": { kind: "hosting", noun: PAGE, proposed: "Restore the page, redirect it to its replacement, or remove the links to it.", effect: "Visitors and crawlers stop hitting a dead end." },
  unreachable: { kind: "hosting", noun: PAGE, effect: "The page answers again, and Google keeps it indexed." },
  "redirect-chain": { kind: "hosting", noun: ["redirect", "redirects"], effect: "Crawlers and visitors take fewer hops." },
  "not-https": { kind: "hosting", noun: PAGE, effect: "Visitors get a secure connection." },
  "invalid-certificate": { kind: "hosting", noun: ISSUE, effect: "Browsers stop warning visitors away." },
  "certificate-expiring": { kind: "hosting", noun: ISSUE, effect: "Browsers won't start warning visitors away." },
  "host-not-canonical": { kind: "hosting", noun: ISSUE, effect: "Google indexes one version of the site." },
  "soft-404": { kind: "hosting", noun: ISSUE, effect: "Google stops indexing missing pages as real ones." },
  "slow-server-response": { kind: "hosting", noun: PAGE, effect: "Pages start loading sooner." },
  "no-compression": { kind: "hosting", noun: PAGE, effect: "Pages download faster." },
  "bot-turned-away": { kind: "hosting", noun: PAGE, effect: "Search crawlers get the page as visitors do." },
  "http-not-redirected": { kind: "hosting", noun: ISSUE, effect: "Google indexes one https copy of the site." },
};

const GSC_FIXES: Record<GscCode, FixDef & { title: string; why: string }> = {
  "gsc-low-ctr": {
    kind: "code",
    noun: TITLE,
    title: "People see this page in Google but rarely click it",
    why: "It already ranks well enough to be seen. Better wording in the result is often the cheapest way to more clicks.",
    proposed: "Rewrite the title and meta description around the searches people use (`search_console.top_queries`): say what the searcher wants and why this page has it. Keep the page's main search words, and don't promise what the page doesn't deliver.",
    effect: "More of the people who already see this page click it. Google can rewrite titles, so SEOpen checks clicks afterwards rather than assuming.",
  },
  "gsc-losing-clicks": {
    kind: "content",
    noun: PAGE,
    title: "This page is losing clicks",
    why: "A page that lost clicks has either dropped in the results or stopped matching what people want.",
    proposed: "Compare the searches people use (`search_console.top_queries`) with what the page says. If it's out of date, update it. If its position held and clicks fell, try the title and description first. Tell the user what you think happened before changing much.",
    forPeople: "Compare the searches people use with what the page says. If it's out of date, update it. If its position held and clicks fell, try the title and description first.",
    effect: "The page stops losing clicks. A seasonal drop won't respond to any change, so SEOpen compares it with the whole site.",
  },
  "gsc-striking-distance": {
    kind: "content",
    noun: PAGE,
    title: "This page is close to page one for a search people make",
    why: "A small move up from positions 4 to 20 brings far more clicks than the same move further down.",
    proposed: "Work these searches (`evidence.queries`) into the title, the headings and the first paragraph where they're true for this page, and add a section if the page doesn't answer them yet.",
    effect: "The page moves up for these searches. This usually takes weeks, so read the 28-day result.",
  },
  "gsc-not-indexed": {
    kind: "code",
    noun: PAGE,
    title: "Google says this page isn't indexed",
    why: "A page that isn't indexed can't appear in Google at all.",
    proposed: "Read what Google says about it (`evidence.coverage`, `evidence.robots`). Remove a noindex or robots rule that's blocking it, fix a canonical pointing elsewhere, and make sure the page is linked and in the sitemap. If it's meant to stay out, dismiss this fix.",
    effect: "Google can index the page once it next crawls it.",
  },
  "gsc-split-query": {
    kind: "content",
    noun: PAGE,
    title: "Two of your pages show for the same search",
    why: "When two pages answer one search, Google splits it between them and often ranks neither well. One clear page for the search is an easier choice for Google.",
    proposed: "For each search in `evidence.queries`, pick the page that should own it: the one whose topic matches the search best, not only the one with more impressions. Make that page answer the search directly in its title, H1 and opening paragraph. On the other page, shorten the part that competes and link to the chosen page with words that match the search. If the pages say much the same thing, ask the user about merging them and redirecting one. Tell the user which page you picked and why before changing much.",
    forPeople: "Pick the page that should own the search: the one whose topic matches it best, not only the one with more impressions. Make that page answer the search directly in its title, heading and opening paragraph. On the other page, shorten the part that competes and link to the chosen page with words that match the search. If the pages say much the same thing, merge them and redirect one.",
    effect: "Google shows one page for the search, and that page can move up. SEOpen measures the page this fix is on, so if the other page owns the search, this one's impressions should fall. This usually takes weeks, so read the 28-day result.",
  },
  "gsc-shown-not-ranking": {
    kind: "content",
    noun: PAGE,
    title: "Google shows this page often, but far down the results",
    why: "Google already ties this page to these searches, but past page three almost nobody clicks. What moves a page up from there is what it says and the links to it, not its title.",
    proposed: "Leave the title alone: a low position is a content and links problem, and a weak title is a click-through problem. First check what kind of page ranks on page one for the main searches (`evidence.queries`). `serp` shows the top 10 but costs " + (rules.hasPlans ? "research credits" : "money at DataForSEO") + ", so ask the user first. If page one is a different kind of page from this one (free tools, guides, lists), say so: the answer may be a page or section of that kind rather than more words here. Otherwise answer those searches directly in the page's text, and link to it from related pages on the site with words that match them. Don't pad it: ask the user what's true before writing.",
    forPeople: "Leave the title: a low position comes from what the page says and the links to it, and a title mostly changes clicks. Search for the page's main searches and look at what kind of page ranks on page one. If it's a different kind (free tools, guides, lists), you may need a page or section of that kind. Otherwise answer those searches directly in the page's text, and link to it from related pages with words that match them.",
    effect: "The page moves up for these searches. From past page three this takes weeks or months, so read the 28-day result.",
  },
  "gsc-wrong-page-type": {
    kind: "content",
    noun: PAGE,
    title: "Google ranks a different kind of page for this search",
    why: "When most of page one is one kind of page, such as free tools or guides, Google has settled on what people want for the search. A page of another kind rarely climbs there, whatever its title says.",
    proposed: "Leave the title alone: a new title doesn't change what kind of page this is. Check the call first: `evidence.page_type_why` says how SEOpen read this page and `evidence.top_urls` what ranks. If SEOpen read the page wrong, tell the user and offer `dismiss_fix`. If it's right, the fix is a page of the kind that ranks (`evidence.dominant_type`: for tools, a free tool that works on the page; for guides or lists, an article that answers the search), linked from this page, or a different search for this page to aim at, one whose results match what it is. Tell the user which you'd do and why before building anything.",
    forPeople: "A new title won't help: Google ranks a different kind of page for this search. Either make a page of the kind that ranks, such as a free tool or a guide, and link to it from this one, or aim this page at a search whose results match what it is. If SEOpen read your page wrong, dismiss this fix.",
    effect: "A page of the kind that ranks can show for the search where this one couldn't. SEOpen measures this page, which may not move if a new page takes the search. This takes weeks, so read the 28-day result.",
  },
};

/**
 * A change someone made without a finding behind it, such as a title rewritten for a page that gets
 * Search Console impressions. `record_change` and the Fixes page's "Log a change" make these, with
 * `source: "manual"`, so they're checked and measured like any fix. `evidence.expect` holds the text
 * the live page should now contain, when one was given.
 */
export const MANUAL_CODE = "manual-change";

export const isManualCode = (code: string) => code === MANUAL_CODE;

const MANUAL_FIX: FixDef & { title: string; why: string } = {
  kind: "code",
  noun: PAGE,
  verb: "Changed",
  title: "A change you logged",
  why: "Logged so SEOpen can check the change reached the live page and compare the page's Search Console numbers before and after.",
  effect: "SEOpen checks the change reached the live page, then compares the page's Search Console numbers before and after at 7, 14 and 28 days.",
};

/** Audit codes that make a fix record. */
export const TRACKED_AUDIT_CODES = new Set(Object.keys(AUDIT_FIXES));

export function fixDef(code: string): FixDef {
  if (isGscCode(code)) return GSC_FIXES[code];
  if (isManualCode(code)) return MANUAL_FIX;
  return AUDIT_FIXES[code] ?? { kind: "content", noun: ISSUE, effect: "The issue no longer shows on the next crawl." };
}

const numberOf = (v: unknown) => (typeof v === "number" ? v : 0);
const serpTypeOf = (v: unknown): SerpType | null => (typeof v === "string" && v in NOUN ? (v as SerpType) : null);
const count = (n: number) => n.toLocaleString("en-US");
const percent = (n: number) => `${Math.round(n * 1000) / 10}%`;

/** The path alone, for a sentence: "/pricing". */
export function pathOf(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
}

/** One finding in plain English, with its own numbers. */
export function plainIssue(fix: { code: string; url: string; detail: string | null; evidence: Record<string, unknown> | null }): string {
  const path = pathOf(fix.url);
  const e = fix.evidence ?? {};
  switch (fix.code) {
    case "gsc-low-ctr":
      return `Google showed ${path} ${count(numberOf(e.impressions))} times in the last 28 days at about position ${numberOf(e.position)}, and ${percent(numberOf(e.ctr))} clicked. A result at that position usually gets about ${percent(numberOf(e.expected_ctr))}.`;
    case "gsc-losing-clicks": {
      const moved = typeof e.position === "number" && e.position > 0 && typeof e.previous_position === "number" && e.previous_position > 0;
      const position = !moved ? "" : e.position === e.previous_position ? ` Its average position held at ${e.position}.` : ` Its average position went from ${e.previous_position} to ${e.position}.`;
      return `${path} got ${count(numberOf(e.clicks))} clicks in the last 28 days, down from ${count(numberOf(e.previous_clicks))} in the 28 before.${position}`;
    }
    case "gsc-striking-distance": {
      const queries = Array.isArray(e.queries) ? (e.queries as { query?: string; position?: number; impressions?: number }[]) : [];
      const top = queries[0];
      // Older records list five searches at most and no total, so the count falls back to the list.
      const others = (typeof e.searches_in_range === "number" ? e.searches_in_range : queries.length) - 1;
      const seen = typeof top?.impressions === "number" ? `, seen ${count(top.impressions)} ${top.impressions === 1 ? "time" : "times"} in the last 28 days` : "";
      const more = others > 0 ? `${seen ? "," : ""} and ${count(others)} other ${others === 1 ? "search" : "searches"} close to page one` : "";
      return top?.query ? `${path} sits at about position ${top.position} for “${top.query}”${seen}${more}.` : `${path} is close to page one for searches people make.`;
    }
    case "gsc-not-indexed":
      return `Google says ${path} isn't indexed${typeof e.coverage === "string" && e.coverage ? `: ${e.coverage}` : ""}.`;
    case "gsc-split-query": {
      const queries = Array.isArray(e.queries) ? (e.queries as { query?: string; pages?: { page?: string; impressions?: number; position?: number }[] }[]) : [];
      const top = queries[0];
      const pages = Array.isArray(top?.pages) ? top.pages.filter((p) => typeof p.page === "string") : [];
      if (!top?.query || pages.length < 2) return `${path} shows for a search another of your pages shows for too.`;
      const others = (typeof e.searches_split === "number" ? e.searches_split : queries.length) - 1;
      const each = pages.map((p) => `${pathOf(p.page!)} (${count(numberOf(p.impressions))} ${numberOf(p.impressions) === 1 ? "impression" : "impressions"}, about position ${numberOf(p.position)})`);
      const more = others > 0 ? ` ${path} shares ${count(others)} other ${others === 1 ? "search" : "searches"} the same way.` : "";
      return `Google showed “${top.query}” on ${count(pages.length)} of your pages in the last 28 days: ${listOf(each)}.${more}`;
    }
    case "gsc-shown-not-ranking": {
      const queries = Array.isArray(e.queries) ? (e.queries as { query?: string; position?: number }[]) : [];
      const clicks = numberOf(e.clicks);
      const got = clicks ? `${count(clicks)} ${clicks === 1 ? "click" : "clicks"}` : "no clicks";
      const top = queries[0]?.query ? ` Its top search is “${queries[0].query}”, at about position ${numberOf(queries[0].position)}.` : "";
      return `Google showed ${path} ${count(numberOf(e.impressions))} times in the last 28 days at about position ${numberOf(e.position)}, past page three, and it got ${got}.${top}`;
    }
    case "gsc-wrong-page-type": {
      const dominant = serpTypeOf(e.dominant_type);
      const own = serpTypeOf(e.page_type);
      if (typeof e.query !== "string" || !dominant || !own) return `Google ranks a different kind of page from ${path} for a search it shows ${path} for.`;
      const others = (typeof e.searches_mismatched === "number" ? e.searches_mismatched : 1 + (Array.isArray(e.other_searches) ? e.other_searches.length : 0)) - 1;
      const more = others ? ` The same goes for ${count(others)} other ${others === 1 ? "search" : "searches"}.` : "";
      return `Google showed ${path} ${count(numberOf(e.impressions))} times for “${e.query}” in the last 28 days, at about position ${numberOf(e.position)}. ${count(numberOf(e.agree))} of the top ${count(numberOf(e.of))} for it are ${NOUN[dominant].many}, and ${path} reads as ${NOUN[own].one}.${more}`;
    }
    case MANUAL_CODE: {
      const sources = linkedFrom(e);
      const links = sources.length ? ` SEOpen checks that ${listOf(sources.map(pathOf))} ${sources.length === 1 ? "links" : "link"} to it.` : "";
      return `${path} was changed${fix.detail ? `: ${trimStop(fix.detail)}` : ""}.${expectedText(e) ? ` SEOpen looks for “${expectedText(e)}” on the live page.` : ""}${links}`;
    }
    default: {
      const def = ISSUES[fix.code];
      const title = def?.title ?? fix.code;
      const match = fix.code === "duplicate-content" ? similarMatch(fix.detail) : null;
      if (match) return `${path}: ${title} (closest match: ${match.url}, ${match.similarity} of 10 alike, 10 is identical${moreSimilar(match.more)}).`;
      const label = def?.detailLabel;
      return `${path}: ${title}${fix.detail ? ` (${label ? `${label.toLowerCase()}: ` : ""}${fix.detail})` : ""}.`;
    }
  }
}

/** "a and b", "a, b and c". */
const listOf = (items: string[]) => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const trimStop = (s: string) => s.trim().replace(/[.\s]+$/, "");

/** The text a logged change said the live page should contain. */
export function expectedText(evidence: Record<string, unknown> | null | undefined): string | null {
  const v = evidence?.expect;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** The pages a logged change says now link to its page (`record_change`'s `linked_from`). */
export function linkedFrom(evidence: Record<string, unknown> | null | undefined): string[] {
  const v = evidence?.linked_from;
  return Array.isArray(v) ? v.filter((u): u is string => typeof u === "string" && u.length > 0) : [];
}

/** The other pages past the closest match that the crawl also found alike: ", and 2 more similar pages". */
const moreSimilar = (n: number) => (n ? `, and ${n} more similar ${n === 1 ? "page" : "pages"}` : "");

/** The finding's own facts for someone reading a list under its title: the title needn't say itself twice. */
export function issueLine(fix: { code: string; url: string; detail: string | null; evidence: Record<string, unknown> | null }): string {
  if (isGscCode(fix.code)) return plainIssue(fix);
  const path = pathOf(fix.url);
  const page = path === "/" ? "The home page" : path;
  if (isManualCode(fix.code)) {
    const expect = expectedText(fix.evidence);
    return `${page}${fix.detail ? `: ${trimStop(fix.detail)}` : ""}.${expect ? ` Looking for “${expect}” on the live page.` : ""}`;
  }
  if (!fix.detail) return page;
  const match = fix.code === "duplicate-content" ? similarMatch(fix.detail) : null;
  if (match) return `${page}. Closest match: ${pathOf(match.url)}, ${match.similarity} of 10 alike (10 is identical)${moreSimilar(match.more)}`;
  const label = ISSUES[fix.code]?.detailLabel;
  return `${page}. ${label ? `${label}: ` : ""}${fix.detail}`;
}

/** The finding, labelled as the before once a check has an after to set beside it. */
export function beforeLine(fix: { code: string; url: string; detail: string | null; evidence: Record<string, unknown> | null; status: string; liveCheck: { saw: string } | null }): string {
  const line = issueLine(fix);
  // A logged change has no finding to be the before: its line is the change itself.
  if (isManualCode(fix.code)) return line;
  return fix.liveCheck && ["applied", "live", "measured"].includes(fix.status) ? `Before: ${line}` : line;
}

/** What a closed or waiting record says under its finding: why it went, or, dated, what the live page showed. */
export function progressLine(fix: { status: string; dismissedReason: string | null; liveCheck: { saw: string; checkedAt: string } | null }, timeZone: string): string | null {
  if (fix.status === "resolved") return "A later crawl or sync no longer finds this.";
  if (fix.status === "dismissed") return fix.dismissedReason ?? null;
  return fix.liveCheck ? `After, checked ${formatShortDate(fix.liveCheck.checkedAt, timeZone)}: ${fix.liveCheck.saw}` : null;
}

/** Under a similar-content record: the pages folded into it (`pairs.ts`), which aren't on the list themselves. */
export function coversLine(urls: string[]): string | null {
  if (!urls.length) return null;
  const paths = urls.map(pathOf);
  const named = paths.length === 1 ? paths[0] : `${paths.slice(0, -1).join(", ")} and ${paths.at(-1)}`;
  return `Also covers ${named}, ${paths.length === 1 ? "its similar pair, so one fix settles both" : "pages much like it, so one fix settles them all"}.`;
}

/** A finding's short name, for a list. */
export function fixTitle(code: string): string {
  if (isManualCode(code)) return MANUAL_FIX.title;
  return isGscCode(code) ? GSC_FIXES[code].title : (ISSUES[code]?.title ?? code);
}

export function whyItMatters(code: string): string {
  if (isManualCode(code)) return MANUAL_FIX.why;
  return isGscCode(code) ? GSC_FIXES[code].why : (ISSUES[code]?.why ?? "");
}

/** Pages that are short on purpose, by their last path segment, with what to call them. */
const SHORT_PAGES: [RegExp, string][] = [
  [/^contact/, "a contact page"],
  [/^accessibility/, "an accessibility statement"],
  [/^(privacy|terms|legal|cookie|imprint|impressum|disclaimer)/, "a legal page"],
  [/^(login|log-in|sign-?in|sign-?up|register|account)/, "a sign-in page"],
  [/^(cart|basket|checkout)/, "a checkout page"],
  [/^(thank-?you|thanks)/, "a thank-you page"],
];

/** What kind of page this is, if it's one that's short on purpose: "a contact page". */
export function shortOnPurpose(url: string): string | null {
  const last = segments(url).at(-1)?.toLowerCase();
  return (last && SHORT_PAGES.find(([re]) => re.test(last))?.[1]) ?? null;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The change to make. With the page's address, little-text advice for a page that's short on purpose says so. */
export function proposedChange(code: string, url?: string): string {
  const base = fixDef(code).proposed ?? ISSUES[code]?.fix ?? "";
  const kind = code === "thin-content" && url ? shortOnPurpose(url) : null;
  return kind ? `${base} This looks like ${kind}, which is often short on purpose: ask the user whether to dismiss this fix instead.` : base;
}

/** The same advice for someone reading the page: what it tells an agent to do, and the fields it points an agent at, mean nothing to them. */
export function proposedForPeople(code: string, url?: string): string {
  const kind = code === "thin-content" && url ? shortOnPurpose(url) : null;
  if (kind) return `${capitalize(kind)} is often short on purpose. If this one says what it needs to, dismiss this fix rather than pad it.`;
  return fixDef(code).forPeople ?? proposedChange(code).replace(/\s*\(`[^)]*`\)/g, "");
}

/** Whether an agent working in the repo can make this change itself. */
export const canAgentFix = (code: string) => fixDef(code).kind !== "hosting";

/** Findings about the whole site: their results read the site's numbers, not one page's. */
export const isSiteWide = (code: string) => !isGscCode(code) && !!ISSUES[code]?.site;

/** The path segments of a URL, without empty ones. */
const segments = (url: string) => pathOf(url).split("/").filter(Boolean);

/**
 * Where a page's code probably lives, per framework. These are guesses from the URL: the agent
 * detects the framework and checks. A dynamic route won't match by name, so the skill searches for
 * the route when these files don't exist.
 */
export function likelyFiles(code: string, url: string): Record<string, string[]> {
  const site: Record<string, Record<string, string[]>> = {
    "no-sitemap": { nextjs: ["app/sitemap.ts"], astro: ["astro.config.mjs (@astrojs/sitemap)"], sveltekit: ["src/routes/sitemap.xml/+server.ts"], html: ["sitemap.xml"] },
    "no-robots-txt": { nextjs: ["app/robots.ts"], astro: ["public/robots.txt"], sveltekit: ["static/robots.txt"], html: ["robots.txt"] },
    "search-bot-blocked": { nextjs: ["app/robots.ts", "public/robots.txt"], astro: ["public/robots.txt"], sveltekit: ["static/robots.txt"], html: ["robots.txt"] },
    "sitemap-lists-bad-url": { nextjs: ["app/sitemap.ts"], astro: ["astro.config.mjs (@astrojs/sitemap)"], sveltekit: ["src/routes/sitemap.xml/+server.ts"], html: ["sitemap.xml"] },
    "no-favicon": { nextjs: ["app/icon.png"], astro: ["public/favicon.svg"], sveltekit: ["static/favicon.png"], html: ["favicon.ico"] },
  };
  if (site[code]) return site[code];
  const parts = segments(url);
  const path = parts.join("/");
  if (!path) {
    return {
      nextjs: ["app/page.tsx", "app/layout.tsx"],
      astro: ["src/pages/index.astro", "src/layouts/"],
      sveltekit: ["src/routes/+page.svelte", "src/routes/+layout.svelte"],
      html: ["index.html"],
    };
  }
  return {
    nextjs: [`app/${path}/page.tsx`, `app/${path}/layout.tsx`, "app/layout.tsx"],
    astro: [`src/pages/${path}.astro`, `src/pages/${path}/index.astro`, `src/content/**/${parts.at(-1)}.md*`, "src/layouts/"],
    sveltekit: [`src/routes/${path}/+page.svelte`, `src/routes/${path}/+page.ts`, "src/routes/+layout.svelte"],
    html: [`${path}.html`, `${path}/index.html`],
  };
}

/** A git hash the way people read one. Anything else an agent passed, such as a branch or a PR link, stays whole. */
export function shortCommit(commit: string): string {
  return /^[0-9a-f]{8,64}$/i.test(commit) ? commit.slice(0, 7) : commit;
}
