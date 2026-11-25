/**
 * The crawlers SEOpen reports on, and what robots.txt lets each one do. Shared by the free AI search
 * readiness checker (`src/modules/tools/readiness.ts`) and the site audit's crawler and AI access
 * checks (`src/modules/audit/access.ts`), so both read the same list and the same rules. Search
 * crawlers decide whether a page can be found and cited; training crawlers are the owner's choice
 * and are never scored or reported as faults. Pure, no I/O.
 */
import { parseRobots, pathRules, type Robots } from "./robots";

export type CrawlerRole = "search" | "training" | "user";

export interface CrawlerDef {
  token: string;
  owner: string;
  role: CrawlerRole;
  /** What allowing it gets you, in plain words. */
  does: string;
}

export const CRAWLERS: CrawlerDef[] = [
  { token: "Googlebot", owner: "Google", role: "search", does: "Google Search, including AI Overviews and AI Mode" },
  { token: "Bingbot", owner: "Microsoft", role: "search", does: "Bing and Copilot; ChatGPT search also leans on Bing" },
  { token: "OAI-SearchBot", owner: "OpenAI", role: "search", does: "Pages ChatGPT search can show and link to" },
  { token: "Claude-SearchBot", owner: "Anthropic", role: "search", does: "Pages Claude's web search can cite" },
  { token: "PerplexityBot", owner: "Perplexity", role: "search", does: "Pages Perplexity can show and cite" },
  { token: "GPTBot", owner: "OpenAI", role: "training", does: "Training data for OpenAI's models" },
  { token: "ClaudeBot", owner: "Anthropic", role: "training", does: "Training data for Anthropic's models" },
  { token: "Google-Extended", owner: "Google", role: "training", does: "Gemini training and grounding (not AI Overviews)" },
  { token: "Applebot-Extended", owner: "Apple", role: "training", does: "Training for Apple Intelligence" },
  { token: "CCBot", owner: "Common Crawl", role: "training", does: "An open crawl many AI models are trained on" },
  { token: "ChatGPT-User", owner: "OpenAI", role: "user", does: "Fetches a page when a ChatGPT user asks for it" },
  { token: "Claude-User", owner: "Anthropic", role: "user", does: "Fetches a page when a Claude user asks for it" },
  { token: "Perplexity-User", owner: "Perplexity", role: "user", does: "Fetches a page when a Perplexity user asks for it" },
];

export const SEARCH_CRAWLERS = CRAWLERS.filter((c) => c.role === "search");
export const TRAINING_CRAWLERS = CRAWLERS.filter((c) => c.role === "training");

export interface CrawlerAccess extends CrawlerDef {
  allowed: boolean;
  /** The robots.txt line that decided it, or null for the default. */
  rule: string | null;
  /** robots.txt has a group for this crawler by name. */
  named: boolean;
}

/** A robots.txt that answered 5xx: crawlers treat it as "keep out" until it's fixed. */
export const robotsDown = (status: number | null) => status !== null && status >= 500;

/**
 * What each crawler may do with `path` (the path and query string, since robots rules match both).
 * `robotsStatus` 5xx blocks every search and training crawler, as the crawlers themselves do; user
 * fetchers act for a person and are left as the rules say.
 */
export function crawlerAccess(robots: Robots, path: string, robotsStatus: number | null = null, crawlers: CrawlerDef[] = CRAWLERS): CrawlerAccess[] {
  const ruleFor = pathRules(robots, path);
  return crawlers.map((c) => {
    const { rule, named } = ruleFor(c.token);
    const access = { ...c, allowed: rule?.allow ?? true, rule: rule ? `${rule.allow ? "Allow" : "Disallow"}: ${rule.pattern}` : null, named };
    return robotsDown(robotsStatus) && c.role !== "user" ? { ...access, allowed: false, rule: `robots.txt answered ${robotsStatus}` } : access;
  });
}

/** A fetched file, as `safeFetch` returns it. */
interface Fetched {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A plain text file rather than a web page: many sites answer a missing path with their home page. */
export const isTextFile = (r: Fetched) => /text\/plain|text\/markdown|^$/i.test(String(r.headers["content-type"] ?? "")) || !/<html/i.test(r.body.slice(0, 500));

/** The rules in a fetched robots.txt. Anything but a 200 text file means no rules; `crawlerAccess` handles a 5xx. */
export function readRobots(r: Fetched | null): Robots {
  return r && r.status === 200 && isTextFile(r) ? parseRobots(r.body) : { groups: [], sitemaps: [] };
}
