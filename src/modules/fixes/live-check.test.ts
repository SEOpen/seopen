import { describe, expect, it } from "vitest";
import { checkTarget, linksCheck, linksTo, liveCheck, snapshotOf } from "./live-check";

const page = (head: string, body = "<p>Enough words on this page to count as a page.</p>", status = 200) => ({ status, html: `<!doctype html><html><head>${head}</head><body>${body}</body></html>`, headers: {} });
const check = (code: string, p: ReturnType<typeof page>, detail: string | null = null, before: Parameters<typeof liveCheck>[2] = null) => liveCheck({ code, detail }, p, before);
const T = (n: number) => "x".repeat(n);

describe("liveCheck", () => {
  it("reads title lengths from the raw page", () => {
    expect(check("title-too-long", page(`<title>${T(50)}</title>`)).state).toBe("fixed");
    expect(check("title-too-long", page(`<title>${T(90)}</title>`)).state).toBe("still_there");
    expect(check("title-too-short", page(`<title>${T(10)}</title>`)).state).toBe("still_there");
    expect(check("missing-title", page("")).state).toBe("still_there");
    expect(check("missing-title", page("<title>Pricing</title>")).saw).toBe("The title is “Pricing”.");
  });

  it("says a failing page is broken instead of judging it", () => {
    expect(check("title-too-long", page("", "", 500)).state).toBe("page_broken");
  });

  it("counts a status finding as fixed when the page answers", () => {
    expect(check("http-5xx", page("", "", 200)).state).toBe("fixed");
    expect(check("http-5xx", page("", "", 503)).state).toBe("still_there");
    expect(check("no-sitemap", page("", "", 404)).state).toBe("still_there");
    // An HTML page at /sitemap.xml is a site answering every path, not a sitemap.
    expect(check("no-sitemap", page("", "", 200)).state).toBe("still_there");
  });

  it("tells a canonical that moved from one that didn't", () => {
    const tag = '<link rel="canonical" href="https://x.com/new">';
    expect(check("canonical-to-broken", page(tag), "https://x.com/old").state).toBe("fixed");
    expect(check("canonical-to-broken", page(tag), "https://x.com/new").state).toBe("still_there");
    expect(check("canonical-to-broken", page(tag)).state).toBe("cannot_check");
  });

  it("finds a noindex, and leaves indexing itself to Google", () => {
    const blocked = page('<meta name="robots" content="noindex">');
    expect(check("non-indexable", blocked).state).toBe("still_there");
    expect(check("non-indexable", page("")).state).toBe("fixed");
    expect(check("gsc-not-indexed", blocked).state).toBe("still_there");
    expect(check("gsc-not-indexed", page("")).state).toBe("cannot_check");
  });

  it("compares duplicate findings with the page before the fix", () => {
    const before = { title: "Same", description: "Same", words: 10, from: "crawl" as const };
    expect(check("duplicate-title", page("<title>Same</title>"), "Same", before).state).toBe("still_there");
    expect(check("duplicate-title", page("<title>New</title>"), "Same", before).state).toBe("fixed");
    // A changed title says nothing about a shared description.
    expect(check("duplicate-description", page('<title>New</title><meta name="description" content="Same">'), "Same", before).state).toBe("still_there");
    expect(check("duplicate-title", page("<title>New</title>"), "Same", null).state).toBe("cannot_check");
  });

  it("won't fail a content fix on an unchanged title", () => {
    const html = page("<title>Same</title>");
    const before = { ...snapshotOf(html.html, "crawl") };
    expect(check("gsc-striking-distance", html, null, before).state).toBe("cannot_check");
    const longer = page("<title>Same</title>", "<p>Enough words on this page to count as a page, and now some new ones too.</p>");
    expect(check("gsc-striking-distance", longer, null, before).state).toBe("fixed");
    expect(check("gsc-low-ctr", html, null, before).state).toBe("still_there");
  });

  it("reads the first of several broken links, and won't call the rest fixed", () => {
    const linked = page("", '<a href="https://x.com/dead">x</a>');
    expect(check("broken-internal-links", linked, "https://x.com/dead").state).toBe("still_there");
    expect(check("broken-internal-links", page(""), "https://x.com/dead").state).toBe("fixed");
    expect(check("broken-internal-links", page(""), "https://x.com/dead (+2 more)").state).toBe("cannot_check");
    expect(check("broken-internal-links", linked, "https://x.com/dead (+2 more)").state).toBe("still_there");
  });

  it("doesn't judge a page's body when it needs JavaScript", () => {
    const shell = page("<title>App</title>", '<div id="root"></div><script src="/app.js"></script>');
    expect(check("missing-h1", shell).state).toBe("cannot_check");
    // The head is still there to read.
    expect(check("missing-title", shell).state).toBe("fixed");
  });

  it("checks alt attributes, doctypes and meta refreshes", () => {
    expect(check("missing-alt", page("", '<img src="a.png"><p>Words words words words words words words words words words words.</p>')).state).toBe("still_there");
    expect(check("missing-alt", page("", '<img src="a.png" alt="">')).state).toBe("fixed");
    expect(check("missing-alt", page("", '<img src="a.png" alt>')).state).toBe("fixed");
    expect(check("missing-alt", page("", '<img src="a.png" alt=""><noscript><img src="https://www.facebook.com/tr?id=1"></noscript>')).state).toBe("fixed");
    expect(check("no-doctype", { status: 200, html: "<html><head></head></html>", headers: {} }).state).toBe("still_there");
    expect(check("no-doctype", page("")).state).toBe("fixed");
    expect(check("meta-refresh", page('<meta http-equiv="refresh" content="0;url=/x">')).state).toBe("still_there");
  });

  it("admits what the page alone can't show", () => {
    expect(check("orphan-page", page("")).state).toBe("cannot_check");
    expect(check("thin-content", page("")).state).toBe("cannot_check");
  });
});

describe("checkTarget", () => {
  it("fetches the site's own file for a site finding", () => {
    expect(checkTarget("no-sitemap", "https://x.com/")).toBe("https://x.com/sitemap.xml");
    expect(checkTarget("no-robots-txt", "https://x.com/")).toBe("https://x.com/robots.txt");
    expect(checkTarget("missing-title", "https://x.com/a")).toBe("https://x.com/a");
  });
});

describe("liveCheck on hostile pages", () => {
  const raw = (html: string) => ({ status: 200, html, headers: {} });
  const fast = (code: string, html: string) => {
    const started = Date.now();
    const result = check(code, raw(html));
    expect(Date.now() - started, code).toBeLessThan(1500);
    return result;
  };

  it("reads leading comments with no doctype in linear time", () => {
    // 28 comments took a second before, and each two more four times as long.
    expect(fast("no-doctype", "<!-- x -->".repeat(10_000) + "<html>").state).toBe("still_there");
    expect(fast("no-doctype", "<!-- a --> \n<!-- b --><!DOCTYPE html><html>").state).toBe("fixed");
    expect(fast("no-doctype", "<!-- never closed <!doctype html>").state).toBe("still_there");
  });

  it("reads 2 MB of unclosed tags in linear time", () => {
    const MB2 = 2 * 1024 * 1024;
    for (const code of ["no-charset", "no-favicon", "meta-refresh", "no-doctype"]) fast(code, "<head><meta " + "a".repeat(MB2));
    fast("no-charset", "<head>" + "<meta ".repeat(MB2 / 6));
  });

  it("still finds the tags it looks for", () => {
    expect(check("no-charset", page('<meta charset="utf-8">')).state).toBe("fixed");
    expect(check("no-charset", page("")).state).toBe("still_there");
    expect(check("no-favicon", page('<link rel="shortcut icon" href="/f.ico">')).state).toBe("fixed");
    expect(check("meta-refresh", page('<meta http-equiv="refresh" content="0;url=/x">')).state).toBe("still_there");
    expect(check("meta-refresh", page("")).state).toBe("fixed");
  });
});

describe("liveCheck on a site-wide file", () => {
  const file = (body: string, contentType = "text/plain", status = 200) => ({ status, html: body, headers: { "content-type": contentType } });

  it("takes a sitemap only when it lists URLs", () => {
    expect(check("no-sitemap", file('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://x.com/</loc></url></urlset>', "application/xml")).state).toBe("fixed");
    expect(check("no-sitemap", file("<sitemapindex><sitemap><loc>https://x.com/s1.xml</loc></sitemap></sitemapindex>", "text/xml")).state).toBe("fixed");
    // A site that answers every path with its home page.
    expect(check("no-sitemap", file("<!doctype html><html><body>Welcome</body></html>", "text/html"))).toMatchObject({ state: "still_there", saw: expect.stringContaining("isn't a sitemap") });
    expect(check("no-sitemap", file("", "application/xml")).state).toBe("still_there");
  });

  it("takes a robots.txt that's text, even an empty one, but not a web page", () => {
    expect(check("no-robots-txt", file("User-agent: *\nDisallow:")).state).toBe("fixed");
    expect(check("no-robots-txt", file("")).state).toBe("fixed");
    expect(check("no-robots-txt", file("<!doctype html><html><body>Not found</body></html>", "text/html"))).toMatchObject({ state: "still_there", saw: expect.stringContaining("web page") });
    expect(check("no-robots-txt", file("<html><body>Not found</body></html>", "")).state).toBe("still_there");
    expect(check("no-robots-txt", file("", "text/plain", 404)).state).toBe("still_there");
  });
});

describe("liveCheck for crawler and AI access", () => {
  const text = (body: string, status = 200, type = "text/plain") => ({ status, html: body, headers: { "content-type": type } });
  const url = "https://x.com/blog/post";

  it("fetches robots.txt and the sitemap for findings about them", () => {
    expect(checkTarget("search-bot-blocked", url)).toBe("https://x.com/robots.txt");
    expect(checkTarget("sitemap-lists-bad-url", url)).toBe("https://x.com/sitemap.xml");
  });

  it("checks robots.txt again for the page the finding named", () => {
    const blocked = liveCheck({ code: "search-bot-blocked", detail: "Googlebot (Disallow: /blog/)", url }, text("User-agent: Googlebot\nDisallow: /blog/"), null);
    expect(blocked).toEqual({ state: "still_there", saw: "robots.txt still blocks Googlebot from /blog/post." });
    // Blocking a training crawler is the owner's choice, so it doesn't keep the finding open.
    expect(liveCheck({ code: "search-bot-blocked", detail: null, url }, text("User-agent: GPTBot\nDisallow: /"), null)).toEqual({ state: "fixed", saw: "robots.txt lets every search crawler fetch /blog/post." });
    expect(liveCheck({ code: "search-bot-blocked", detail: null, url }, text("", 404), null).state).toBe("fixed");
    expect(liveCheck({ code: "search-bot-blocked", detail: null, url }, text("", 503), null).state).toBe("still_there");
  });

  it("looks for the URL in the sitemap", () => {
    const sitemap = (loc: string) => text(`<urlset><url><loc>${loc}</loc></url></urlset>`, 200, "application/xml");
    expect(liveCheck({ code: "sitemap-lists-bad-url", detail: "404", url }, sitemap(url), null).state).toBe("still_there");
    expect(liveCheck({ code: "sitemap-lists-bad-url", detail: "404", url }, sitemap("https://x.com/"), null).state).toBe("fixed");
    expect(liveCheck({ code: "sitemap-lists-bad-url", detail: "404", url }, text("<sitemapindex><sitemap><loc>https://x.com/s1.xml</loc></sitemap></sitemapindex>"), null).state).toBe("cannot_check");
  });

  it("compares the raw HTML with what the crawl saw rendered", () => {
    const words = (n: number, h1 = "") => page("", `${h1}<p>${Array.from({ length: n }, () => "word").join(" ")}</p>`);
    expect(check("content-needs-javascript", words(10), "12 of 900 words, no H1").state).toBe("still_there");
    expect(check("content-needs-javascript", words(600), "12 of 900 words, no H1").state).toBe("still_there");
    expect(check("content-needs-javascript", words(600, "<h1>Hi</h1>"), "12 of 900 words, no H1").state).toBe("fixed");
    expect(check("content-needs-javascript", words(5, "<h1>Hi</h1>"), "no H1").state).toBe("fixed");
    expect(check("content-needs-javascript", words(600), null).state).toBe("cannot_check");
  });
});

describe("a logged change", () => {
  const manual = (p: ReturnType<typeof page>, before: Parameters<typeof liveCheck>[2], expect?: string) => liveCheck({ code: "manual-change", detail: null, evidence: expect ? { expect } : null }, p, before);
  const was = (html: string) => snapshotOf(html, "live");
  const old = page('<title>Old title</title><meta name="description" content="Old words">', "<h1>Old <em>heading</em></h1><p>Body text.</p>");

  it("is live once the page contains the text it named, in any case and spacing", () => {
    const now = page("<title>Pricing  for Small\nTeams</title>", "<h1>Plans</h1>");
    expect(manual(now, was(old.html), "pricing for small teams")).toEqual({ state: "fixed", saw: "The page contains “pricing for small teams”." });
    expect(manual(page("", "<p>We now   ship on Fridays.</p>"), null, "ship on fridays").state).toBe("fixed");
    expect(manual(page('<meta name="description" content="A new description">'), null, "new description").state).toBe("fixed");
    expect(manual(old, was(old.html), "Pricing for small teams")).toEqual({ state: "still_there", saw: "The page doesn't contain “Pricing for small teams” yet." });
  });

  it("can't judge text on a page that needs JavaScript", () => {
    expect(manual(page("<title>App</title>", '<div id="root"></div>'), null, "new intro").state).toBe("cannot_check");
  });

  it("with no text named, is live once the title, description or H1 differs from when it was logged", () => {
    const before = was(old.html);
    expect(before.h1).toBe("Old heading");
    expect(manual(old, before).state).toBe("still_there");
    expect(manual(page('<title>New title</title><meta name="description" content="Old words">', "<h1>Old heading</h1>"), before).saw).toBe("The title changed to “New title”.");
    expect(manual(page('<title>Old title</title><meta name="description" content="New words">', "<h1>Old heading</h1>"), before).saw).toBe("The meta description changed.");
    expect(manual(page('<title>Old title</title><meta name="description" content="Old words">', "<h1>New heading</h1>"), before).saw).toBe("The H1 changed to “New heading”.");
    expect(manual(old, null).state).toBe("cannot_check");
  });

  it("says a failing page is broken", () => {
    expect(manual(page("", "", 404), null, "anything").state).toBe("page_broken");
  });
});

describe("links added to a page", () => {
  const target = "https://fix.example/pricing";
  const from = (url: string, body: string, status = 200) => ({ url, page: page("<title>Post</title>", body, status) });

  it("finds a link to the page under any of its addresses, relative ones read against the linking page", () => {
    const at = "https://fix.example/blog/post";
    expect(linksTo('<a href="/pricing">plans</a>', at, target)).toBe(true);
    expect(linksTo('<a class="x" href="https://www.fix.example/pricing/?ref=blog#top">plans</a>', at, target)).toBe(true);
    expect(linksTo('<a href="../pricing">plans</a>', at, target)).toBe(true);
    expect(linksTo('<a href="http://fix.example/pricing">plans</a>', at, target)).toBe(true);
    expect(linksTo('<a href="/pricing-old">old</a><a href="https://other.example/pricing">x</a>', at, target)).toBe(false);
    expect(linksTo('<a href="mailto:pricing@fix.example">mail</a><a>no href</a>', at, target)).toBe(false);
  });

  it("is live once every linking page links to it, and names the ones that don't yet", () => {
    const a = from("https://fix.example/a", '<p>See <a href="/pricing">our plans</a>.</p>');
    const b = from("https://fix.example/b", "<p>No link here yet, only enough words.</p>");
    expect(linksCheck(target, [a])).toEqual({ state: "fixed", saw: "/a links to /pricing." });
    expect(linksCheck(target, [a, { ...a, url: "https://fix.example/c" }])).toEqual({ state: "fixed", saw: "All 2 pages link to /pricing." });
    expect(linksCheck(target, [a, b])).toEqual({ state: "still_there", saw: "1 of 2 pages link to /pricing. Not yet: /b." });
  });

  it("can't judge a linking page it couldn't read, or one that needs JavaScript", () => {
    const a = from("https://fix.example/a", '<a href="/pricing">plans</a>');
    expect(linksCheck(target, [a, { url: "https://fix.example/gone", error: "That site didn't answer." }]).state).toBe("cannot_check");
    expect(linksCheck(target, [a, from("https://fix.example/404", "", 404)]).state).toBe("cannot_check");
    expect(linksCheck(target, [from("https://fix.example/app", '<div id="root"></div>')]).state).toBe("cannot_check");
  });
});
