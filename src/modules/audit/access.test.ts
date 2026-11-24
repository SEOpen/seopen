import { describe, expect, it } from "vitest";
import { parseRobots } from "@/lib/web/robots";
import type { FetchOptions, FetchResult } from "@/lib/web/fetch";
import { botFetchFindings, checkAccess, httpFinding, keyPages, renderFindings, robotsFindings, sitemapFindings, type BotProbe } from "./access";
import type { CrawledPage } from "./issues";
import { ISSUES } from "./taxonomy";

const T = "example.com";
const at = (path: string) => `https://${T}${path}`;

function page(path: string, over: Partial<CrawledPage> = {}): CrawledPage {
  return {
    url: at(path),
    statusCode: 200,
    resourceType: "html",
    location: null,
    title: "A page",
    description: null,
    h1s: ["A page"],
    canonical: null,
    depth: 1,
    wordCount: 400,
    internalLinksIn: 3,
    loadTimeMs: null,
    waitingTimeMs: null,
    sizeBytes: null,
    duplicateTitle: false,
    duplicateDescription: false,
    duplicateContent: false,
    checks: {},
    ...over,
  };
}

/** robots.txt fixtures. */
const ROBOTS = {
  searchBotBlocked: "User-agent: *\nAllow: /\n\nUser-agent: OAI-SearchBot\nUser-agent: PerplexityBot\nDisallow: /",
  trainingOnly: "User-agent: GPTBot\nUser-agent: ClaudeBot\nUser-agent: Google-Extended\nUser-agent: CCBot\nDisallow: /\n\nUser-agent: *\nAllow: /",
  wildcard: "User-agent: *\nDisallow: /",
  empty: "",
};

describe("robotsFindings", () => {
  const home = [at("/")];

  it("flags a search crawler blocked by name, naming the rule", () => {
    expect(robotsFindings(parseRobots(ROBOTS.searchBotBlocked), 200, home)).toEqual([
      { code: "search-bot-blocked", url: at("/"), detail: "OAI-SearchBot and PerplexityBot (Disallow: /)" },
    ]);
  });

  it("never flags training crawlers blocked on their own", () => {
    expect(robotsFindings(parseRobots(ROBOTS.trainingOnly), 200, home)).toEqual([]);
  });

  it("flags every search crawler under a wildcard disallow", () => {
    const [row] = robotsFindings(parseRobots(ROBOTS.wildcard), 200, home);
    expect(row.detail).toBe("Googlebot, Bingbot, OAI-SearchBot, Claude-SearchBot and PerplexityBot (Disallow: /)");
  });

  it("finds nothing in an empty file", () => {
    expect(robotsFindings(parseRobots(ROBOTS.empty), 200, home)).toEqual([]);
  });

  it("treats a robots.txt server error as blocking every search crawler", () => {
    const [row] = robotsFindings(parseRobots(""), 503, home);
    expect(row.detail).toBe("Googlebot, Bingbot, OAI-SearchBot, Claude-SearchBot and PerplexityBot (robots.txt answered 503)");
  });

  it("judges each key page by its own path", () => {
    const robots = parseRobots("User-agent: Googlebot\nDisallow: /blog/");
    expect(robotsFindings(robots, 200, [at("/"), at("/blog/post"), at("/about")])).toEqual([{ code: "search-bot-blocked", url: at("/blog/post"), detail: "Googlebot (Disallow: /blog/)" }]);
  });
});

describe("keyPages", () => {
  it("starts with the home page, then the most linked-to pages that answered 200", () => {
    const pages = [page("/", { internalLinksIn: 50 }), page("/a", { internalLinksIn: 2 }), page("/b", { internalLinksIn: 9 }), page("/gone", { statusCode: 404, internalLinksIn: 99 }), page("/hidden", { internalLinksIn: 40 })];
    expect(keyPages(T, pages, new Set([at("/hidden")]), 2)).toEqual([at("/"), at("/b"), at("/a")]);
  });
});

describe("botFetchFindings", () => {
  const probe = (baseline: number | null, statuses: (number | null)[]): BotProbe => ({ url: at("/"), baseline, bots: statuses.map((status, i) => ({ token: `Bot${i}`, status })) });

  it("warns when a crawler's user agent gets a different answer from a visitor", () => {
    expect(botFetchFindings([probe(200, [200, 403, null])])).toEqual([{ code: "bot-turned-away", url: at("/"), detail: "Bot1 403, Bot2 no answer" }]);
  });

  it("says nothing when the page fails for visitors too", () => {
    expect(botFetchFindings([probe(503, [503, 503])])).toEqual([]);
    expect(botFetchFindings([probe(null, [403])])).toEqual([]);
  });
});

describe("renderFindings", () => {
  it("flags a page whose H1 or most of whose text needs JavaScript", () => {
    expect(
      renderFindings([
        { url: at("/shell"), renderedH1: true, renderedWords: 900, rawH1: 0, rawWords: 12 },
        { url: at("/h1"), renderedH1: true, renderedWords: 40, rawH1: 0, rawWords: 40 },
        { url: at("/fine"), renderedH1: true, renderedWords: 900, rawH1: 1, rawWords: 800 },
      ]),
    ).toEqual([
      { code: "content-needs-javascript", url: at("/shell"), detail: "12 of 900 words, no H1" },
      { code: "content-needs-javascript", url: at("/h1"), detail: "no H1" },
    ]);
  });
});

describe("httpFinding", () => {
  it("flags http:// answering without moving to https", () => {
    expect(httpFinding(T, { status: 200, finalUrl: `http://${T}/` })).toEqual([{ code: "http-not-redirected", url: at("/"), detail: "200" }]);
    expect(httpFinding(T, { status: 200, finalUrl: at("/") })).toEqual([]);
    expect(httpFinding(T, null)).toEqual([]);
  });
});

describe("sitemapFindings", () => {
  it("flags listed URLs the crawl found redirecting, failing or kept out of search", () => {
    const pages = [page("/ok"), page("/moved", { statusCode: 301, location: at("/new") }), page("/gone", { statusCode: 404 }), page("/private")];
    const rows = sitemapFindings([at("/ok"), at("/moved"), at("/gone"), at("/private"), at("/never-crawled"), at("/ok")], pages, [{ url: at("/private"), reason: "meta_tag" }]);
    expect(rows).toEqual([
      { code: "sitemap-lists-bad-url", url: at("/moved"), detail: `301 → ${at("/new")}` },
      { code: "sitemap-lists-bad-url", url: at("/gone"), detail: "404" },
      { code: "sitemap-lists-bad-url", url: at("/private"), detail: "noindex" },
    ]);
  });
});

describe("checkAccess", () => {
  /** A fake site: robots.txt, a sitemap, and a firewall that turns away OAI-SearchBot. */
  function site(robots: { status: number; body: string } | Error) {
    const calls: { url: string; opts: FetchOptions }[] = [];
    const fetch = async (url: string, opts: FetchOptions = {}): Promise<FetchResult> => {
      calls.push({ url, opts });
      const res = (status: number, body = "", type = "text/html", finalUrl = url): FetchResult => ({ url: finalUrl, status, headers: { "content-type": type }, body, truncated: false, redirects: [], ms: 1 });
      if (url.endsWith("/robots.txt")) {
        if (robots instanceof Error) throw robots;
        return res(robots.status, robots.body, "text/plain");
      }
      if (url.endsWith("/sitemap.xml")) return res(200, `<urlset><url><loc>${at("/")}</loc></url><url><loc>${at("/old")}</loc></url></urlset>`, "application/xml");
      if (url.startsWith("http://")) return res(200, "", "text/html", at("/"));
      if (opts.userAgent?.includes("OAI-SearchBot")) return res(403);
      return res(200, "<html><body><h1>Hi</h1><p>Words here.</p></body></html>");
    };
    return { calls, deps: { fetch, now: () => Date.parse("2026-11-15T12:00:00Z") } };
  }
  const pages = [page("/"), page("/old", { statusCode: 301, location: at("/new") })];

  it("reports robots.txt with its fetch time, the bot fetch test and the sitemap", async () => {
    const { deps } = site({ status: 200, body: ROBOTS.trainingOnly });
    const { issues, report } = await checkAccess({ target: T, enableJavascript: false }, pages, [], deps);
    expect(issues).toEqual([
      { code: "bot-turned-away", url: at("/"), detail: "OAI-SearchBot 403" },
      { code: "sitemap-lists-bad-url", url: at("/old"), detail: `301 → ${at("/new")}` },
    ]);
    expect(report?.robots).toMatchObject({ url: at("/robots.txt"), status: 200, found: true, fetchedAt: "2026-11-15T12:00:00.000Z" });
    // Training crawlers are listed as the owner's choice; user fetchers aren't listed.
    expect(report?.crawlers.filter((c) => !c.allowed).map((c) => [c.token, c.role])).toEqual([
      ["GPTBot", "training"],
      ["ClaudeBot", "training"],
      ["Google-Extended", "training"],
      ["CCBot", "training"],
    ]);
    expect(report?.crawlers.some((c) => c.role === "user")).toBe(false);
    expect(report?.rendered).toBeNull();
    expect(report?.sitemap).toEqual({ url: at("/sitemap.xml"), status: 200, listed: 2 });
  });

  it("sends the visitor request as a browser and each search crawler by its user agent", async () => {
    const { calls, deps } = site({ status: 404, body: "" });
    await checkAccess({ target: T, enableJavascript: false }, [page("/")], [], deps);
    const home = calls.filter((c) => c.url === at("/") && c.opts.headOnly).map((c) => c.opts.userAgent ?? "");
    expect(home).toHaveLength(6);
    expect(home[0]).toMatch(/Chrome/);
    for (const token of ["Googlebot", "bingbot", "OAI-SearchBot", "Claude-SearchBot", "PerplexityBot"]) expect(home.some((ua) => ua.includes(token))).toBe(true);
  });

  it("flags search crawlers blocked by a wildcard rule, and nothing for a missing file", async () => {
    const blocked = await checkAccess({ target: T, enableJavascript: false }, [page("/")], [], site({ status: 200, body: ROBOTS.wildcard }).deps);
    expect(blocked.issues.filter((i) => i.code === "search-bot-blocked")).toHaveLength(1);
    const missing = await checkAccess({ target: T, enableJavascript: false }, [page("/")], [], site({ status: 404, body: "" }).deps);
    expect(missing.issues.filter((i) => i.code === "search-bot-blocked")).toEqual([]);
    expect(missing.report?.robots.found).toBe(false);
  });

  it("says nothing about robots rules when robots.txt couldn't be fetched", async () => {
    const { issues, report } = await checkAccess({ target: T, enableJavascript: false }, [page("/")], [], site(new Error("That site didn't answer.")).deps);
    expect(issues.some((i) => i.code === "search-bot-blocked")).toBe(false);
    expect(report?.robots).toMatchObject({ status: null, found: false });
    expect(report?.robots.error).toBeTruthy();
    expect(report?.crawlers).toEqual([]);
  });

  it("compares raw HTML with the rendered page only on crawls that ran JavaScript", async () => {
    const rendered = [page("/", { wordCount: 900, h1s: ["Welcome"] })];
    const js = await checkAccess({ target: T, enableJavascript: true }, rendered, [], site({ status: 404, body: "" }).deps);
    expect(js.issues.find((i) => i.code === "content-needs-javascript")).toEqual({ code: "content-needs-javascript", url: at("/"), detail: "3 of 900 words" });
    expect(js.report?.rendered).toEqual({ checked: 1, flagged: 1 });
  });

  it("never throws", async () => {
    const broken = { fetch: async () => undefined as unknown as FetchResult, now: () => 0 };
    const errors = console.error;
    console.error = () => {};
    const out = await checkAccess({ target: T, enableJavascript: false }, [page("/")], [], broken).finally(() => (console.error = errors));
    expect(out.issues).toEqual([]);
  });

  it("only reports codes the taxonomy knows, in the access category", () => {
    for (const code of ["search-bot-blocked", "bot-turned-away", "content-needs-javascript", "http-not-redirected", "sitemap-lists-bad-url"]) expect(ISSUES[code]?.category).toBe("access");
  });
});
