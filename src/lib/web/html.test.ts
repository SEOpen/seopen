import { describe, expect, it } from "vitest";
import { contentWordCount, elements, openTags, pageFacts, snippetBlocks, stripTags, visibleText, xRobotsDirectives } from "./html";

describe("xRobotsDirectives", () => {
  it("keeps unprefixed and googlebot directives, drops other crawlers'", () => {
    expect(xRobotsDirectives("noindex, nofollow")).toEqual(["noindex", "nofollow"]);
    expect(xRobotsDirectives("googlebot: nosnippet")).toEqual(["nosnippet"]);
    expect(xRobotsDirectives("bingbot: noindex")).toEqual([]);
  });
  it("reads value directives without mistaking them for a user agent", () => {
    expect(xRobotsDirectives("max-snippet : 0")).toEqual(["max-snippet:0"]);
  });
});

describe("pageFacts", () => {
  const html = `<!doctype html><html lang="en"><head>
    <title>Acme &amp; Co</title>
    <meta name="description" content="Running shoes">
    <meta name="robots" content="index, max-snippet:-1">
    <link rel="canonical" href="https://acme.com/">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization"},{"@type":"WebSite"}]}</script>
    <script type="application/ld+json">{broken</script>
  </head><body><h1>Shoes</h1><h2>A</h2><p>${"word ".repeat(120)}</p><script>var x = "not counted";</script></body></html>`;
  const f = pageFacts(html, { "x-robots-tag": "nosnippet" });

  it("reads title, description, lang, canonical and headings", () => {
    expect(f).toMatchObject({ title: "Acme & Co", description: "Running shoes", lang: "en", canonical: "https://acme.com/", h1: 1, h2: 1 });
  });
  it("merges meta robots with the X-Robots-Tag header", () => {
    expect(f.robots).toEqual(["index", "max-snippet:-1", "nosnippet"]);
    expect(snippetBlocks(f.robots)).toEqual(["nosnippet"]);
  });
  it("collects JSON-LD types and counts broken blocks", () => {
    expect(f.schemaTypes).toEqual(["Organization", "WebSite"]);
    expect(f.jsonLdBlocks).toBe(2);
    expect(f.jsonLdErrors).toBe(1);
  });
  it("counts visible words only", () => {
    expect(f.words).toBe(122);
    expect(f.jsShell).toBe(false);
  });
  it("spots an empty app shell", () => {
    expect(pageFacts('<html><body><div id="root"></div><script src="/app.js"></script></body></html>').jsShell).toBe(true);
  });
});

describe("visibleText", () => {
  it("decodes common named entities", () => {
    expect(visibleText("<body>A &mdash; B&rsquo;s &hellip;</body>")).toBe("A — B’s …");
  });
  it("drops scripts, styles and comments", () => {
    expect(visibleText("<body><style>a{}</style><!-- hi --><p>Hello <b>world</b></p></body>")).toBe("Hello world");
  });
});

describe("hostile HTML", () => {
  const MB2 = 2_000_000;
  const pages: Record<string, string> = {
    "unclosed scripts": "<body>" + "<script>".repeat(MB2 / 8),
    "unclosed JSON-LD": "<body>" + '<script type="application/ld+json">'.repeat(MB2 / 35),
    "meta tags with no >": "<head>" + "<meta ".repeat(MB2 / 6),
    "unclosed comments": "<body>" + "<!--".repeat(MB2 / 4),
    "unclosed titles": "<head>" + "<title>".repeat(MB2 / 7),
    "unclosed bodies": "<body>".repeat(MB2 / 6),
    "a run of <": "<body>" + "<".repeat(MB2),
    "one tag of divs": "<body><div " + "<div ".repeat(MB2 / 5) + ">",
    "one long attribute name": "<head><meta " + "a".repeat(MB2) + ">",
    "a directive with a long gap": `<head><meta name="robots" content="a${" ".repeat(MB2)}b"></head>`,
    "a title with a long gap": `<head><title>a${" ".repeat(MB2)}b</title></head>`,
    "attributes with long gaps": `<head><meta name${" ".repeat(MB2)}x></head>`,
  };

  it("reads a 2 MB page of unclosed markup in linear time", () => {
    for (const [name, html] of Object.entries(pages)) {
      const started = Date.now();
      pageFacts(html);
      // Each took minutes before; linear scanning takes tens of milliseconds.
      expect(Date.now() - started, name).toBeLessThan(1500);
    }
  });

  it("finds elements as the lazy regex did, skipping a name with no closer left", () => {
    const html = "<h1>a</h1><h2 class=x>b<h3>c</h3></h2><h3>unclosed<h1>d</h1>";
    expect(elements(html, ["h1", "h2", "h3"]).map((e) => [e.name, e.inner])).toEqual([
      ["h1", "a"],
      ["h2", "b<h3>c</h3>"],
      ["h1", "d"],
    ]);
    expect(elements(html, ["h1"], 1)).toHaveLength(1);
    expect(openTags('<a href="/x"><a\nhref="/y"><abbr>', "a").map((t) => t.raw)).toEqual(['<a href="/x">', '<a\nhref="/y">']);
  });

  it("keeps the text after an unclosed script or the last >", () => {
    expect(visibleText("<body><p>Hello</p><script>var x = 1; never closed")).toBe("Hello var x = 1; never closed");
    expect(stripTags("<b>bold</b> then a < b")).toBe(" bold  then a < b");
    expect(pageFacts('<html lang="en-GB"><head><title>T &amp; Co</title></head><body><div id="root"></div></body></html>')).toMatchObject({ lang: "en-GB", title: "T & Co", jsShell: true });
  });
});

describe("contentWordCount", () => {
  const cards = Array.from({ length: 4 }, (_, i) => `<a href="/s/${i}"><h3>Service ${i}</h3><p>We build fast sites for local shops and trades.</p></a>`).join("");

  it("counts link text inside main, which a card grid keeps most of its copy in", () => {
    const html = `<html><body><header><nav><a href="/">Home</a> <a href="/about">About us</a></nav></header><main><h1>Services</h1>${cards}</main><footer>Footer words here</footer></body></html>`;
    expect(contentWordCount(html)).toBe(1 + 4 * 11);
  });

  it("without main, counts the body minus header, nav, footer and aside", () => {
    const html = `<html><body><nav>One two three</nav><h1>Hello world</h1><aside>Side note</aside><footer>Four five</footer></body></html>`;
    expect(contentWordCount(html)).toBe(2);
  });

  it("leaves out scripts and commented-out markup", () => {
    expect(contentWordCount(`<main><!-- <p>hidden words</p> --><script>var a = "b c d";</script><p>Seen</p></main>`)).toBe(1);
  });
});
