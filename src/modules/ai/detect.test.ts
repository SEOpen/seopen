import { describe, expect, it } from "vitest";
import {
  cleanTitle,
  cleanUrl,
  citationLabel,
  detect,
  domainLabel,
  extractCitations,
  findSpans,
  hostOf,
  makeBrand,
  namesBrand,
  ownBrand,
  projectNameAlias,
  readCitation,
  segments,
  siteOf,
} from "./detect";

const us = makeBrand("alphanote.example", true, ["alphanote.test"]);
const gammanest = makeBrand("gammanest.example", false);
const margin = makeBrand("deltabarn.example", false, ["Margin"]);
const brands = [us, gammanest, margin];

const mentioned = (text: string, b = us) => findSpans(text, [b]).length > 0;

describe("domain helpers", () => {
  it("normalizes hosts", () => {
    expect(hostOf("https://www.AlphaNote.test/pricing?x=1")).toBe("alphanote.test");
    expect(hostOf("blog.example.com:443/a")).toBe("blog.example.com");
  });

  it("finds the brand label of a domain", () => {
    expect(domainLabel("alphanote.example")).toBe("alphanote");
    expect(domainLabel("www.foo.co.uk")).toBe("foo");
    expect(domainLabel("plainpad.github.io")).toBe("plainpad");
    expect(domainLabel("app.deltabarn.example")).toBe("deltabarn");
  });

  it("builds a brand from domain and aliases", () => {
    expect(us.domains).toEqual(["alphanote.example", "alphanote.test"]);
    expect(us.names).toContain("alphanote");
    expect(margin.name).toBe("Margin");
    expect(us.name).toBe("Alphanote");
    expect(makeBrand("jotwell.example", false, ["Jotwell Pro"]).name).toBe("Jotwell");
  });

  it("shows a name that is the domain spelled properly as typed, and a competitor's domain when none is known", () => {
    expect(makeBrand("harlowseo.com", false, ["Harlow SEO"]).name).toBe("Harlow SEO");
    expect(makeBrand("harlowseo.com", false).name).toBe("harlowseo.com");
    expect(makeBrand("https://www.HarlowSEO.com/", false).name).toBe("harlowseo.com");
    expect(makeBrand("harlowseo.com", false, ["Harlow SEO LLC"]).name).toBe("harlowseo.com");
    expect(makeBrand("harlowseo.com", false, ["harlowseo.net"]).name).toBe("harlowseo.com");
    expect(makeBrand("harlowseo.com", true).name).toBe("Harlowseo");
  });
});

describe("brand name variants", () => {
  it.each([
    "Try AlphaNote for shared notes.",
    "Try Alphanote for shared notes.",
    "ALPHANOTE is great",
    "alphanote is great",
    "Alpha Note is great",
    "Alpha-Note is great",
    "alpha-note is great",
    "Download it from alphanote.test today",
    "See https://www.alphanote.example/download",
    "AlphaNote' scenes are calm",
    "(AlphaNote)",
    "**AlphaNote** — best overall",
  ])("matches %s", (text) => {
    expect(mentioned(text)).toBe(true);
  });

  it.each([
    "alphanoteque is not a word",
    "Alpha note of the mind",
    "The apps escape the dock",
    "myalphanote",
  ])("does not match %s", (text) => {
    expect(mentioned(text)).toBe(false);
  });

  it("does not fire a lowercase split brand on a common phrase", () => {
    expect(mentioned("Tuck the gamma nest into the drawer", gammanest)).toBe(false);
    expect(mentioned("Gamma Nest is a notes app", gammanest)).toBe(true);
    expect(mentioned("Gammanest is a notes app", gammanest)).toBe(true);
  });

  it("matches user aliases, multi-word in any spacing", () => {
    const b = makeBrand("example.com", false, ["Dynamic Notes Engine"]);
    expect(mentioned("Try dynamic notes engine", b)).toBe(true);
    expect(mentioned("Try Dynamic-Notes  Engine", b)).toBe(true);
    expect(mentioned("Margin by Deltabarn", margin)).toBe(true);
  });

  it("keeps the longest match when names overlap", () => {
    const spans = findSpans("Visit alphanote.test now", [us]);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 6, end: 20 });
  });
});

describe("citations", () => {
  it("collects annotations, markdown links and bare URLs, deduped", () => {
    const text =
      "AlphaNote ([alphanote.test](https://alphanote.test/?utm_source=openai)) and Gammanest (https://gammanest.example/).";
    const cites = extractCitations(text, [
      { url: "https://alphanote.test/?utm_source=openai", title: "AlphaNote" },
      { url: "https://www.reddit.com/r/macapps/comments/1", title: "r/macapps" },
    ]);
    expect(cites.map((c) => c.url)).toEqual([
      "https://alphanote.test/",
      "https://www.reddit.com/r/macapps/comments/1",
      "https://gammanest.example/",
    ]);
    expect(cites.map((c) => c.domain)).toEqual(["alphanote.test", "reddit.com", "gammanest.example"]);
    expect(cites[0].title).toBe("AlphaNote");
  });

  it("strips tracking params and fragments", () => {
    expect(cleanUrl("https://a.com/x?utm_source=chatgpt.com&id=2#top")).toBe("https://a.com/x?id=2");
  });

  it("doesn't take a markdown link's text for the page's title", () => {
    const [page] = extractCitations("Try [Moz Pro](https://gizmodo.com/best-seo-tools-2026).");
    expect(page).toEqual({ url: "https://gizmodo.com/best-seo-tools-2026", domain: "gizmodo.com", title: null });
    // A Gemini redirect's text can still name the site it leads to.
    const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ";
    expect(extractCitations(`[epsilonapps.example](${redirect})`)[0].domain).toBe("epsilonapps.example");
  });

  it("trims trailing punctuation from bare URLs", () => {
    expect(extractCitations("See https://deltabarn.example/margin.").map((c) => c.url)).toEqual(["https://deltabarn.example/margin"]);
  });

  it("credits a Gemini redirect to the site named in its title", () => {
    const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEEkL7Xlx1gJ";
    expect(extractCitations("", [{ url: redirect, title: "www.BetaWeb.example" }])[0].domain).toBe("betaweb.example");
    // A title that isn't a domain says nothing about the site, so the host stands.
    expect(extractCitations("", [{ url: redirect, title: "Top 20 web design companies" }])[0].domain).toBe("vertexaisearch.cloud.google.com");
    // Only Gemini's redirect: an ordinary link keeps its own host whatever its title says.
    expect(extractCitations("", [{ url: "https://clutch.co/nh", title: "betaweb.example" }])[0].domain).toBe("clutch.co");
  });

  it("takes a search breadcrumb off the front of a title", () => {
    expect(cleanTitle("www.designrush.com › agency › website-designTop Salem Web Designers | 2026")).toBe("Top Salem Web Designers | 2026");
    expect(cleanTitle("clutch.co › web-designers › salem Top Web Designers in Salem")).toBe("Top Web Designers in Salem");
    // Nothing to take off, or nothing would be left: the title stands.
    expect(cleanTitle("Top Salem Web Designers")).toBe("Top Salem Web Designers");
    expect(cleanTitle("betaweb.example")).toBe("betaweb.example");
    expect(cleanTitle("example.com › blog › post")).toBe("example.com › blog › post");
    expect(cleanTitle(null)).toBeNull();
    expect(extractCitations("", [{ url: "https://www.designrush.com/agency/x", title: "www.designrush.com › agency › website-designTop Salem Web Designers | 2026" }])[0].title).toBe("Top Salem Web Designers | 2026");
  });

  it("reads a stored Gemini redirect as the site its title names, or as a hidden source", () => {
    const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQF2whXDBQ";
    // Stored before the title's domain was credited, so the row still names Google's host.
    const named = readCitation({ url: redirect, domain: "vertexaisearch.cloud.google.com", title: "landscape.directory" });
    expect(named).toEqual({ url: redirect, domain: "landscape.directory", title: null, gemini: true });
    expect(citationLabel(named)).toBe("Gemini link to landscape.directory");
    const hidden = readCitation({ url: redirect, domain: "vertexaisearch.cloud.google.com", title: "Top 20 web design companies" });
    expect(hidden).toEqual({ url: redirect, domain: null, title: "Top 20 web design companies", gemini: true });
    expect(citationLabel(hidden)).toBe("Gemini link, source hidden");
    const plain = readCitation({ url: "https://www.designrush.com/agency/x", domain: "designrush.com", title: "www.designrush.com › agency › website-designTop Salem Web Designers | 2026" });
    expect(plain).toEqual({ url: "https://www.designrush.com/agency/x", domain: "designrush.com", title: "Top Salem Web Designers | 2026", gemini: false });
    expect(citationLabel(plain)).toBe("www.designrush.com/agency/x");
  });
});

describe("detect", () => {
  const text = [
    "The best shared notes apps for Mac:",
    "1. **Gammanest** — huge library.",
    "2. **Margin** by Deltabarn — polished.",
    "3. **AlphaNote** — GPU scenes. AlphaNote also has widgets.",
  ].join("\n");

  it("reports mention, count, position and first offset per brand", () => {
    const d = detect(text, [], brands);
    expect(d.mentioned).toBe(true);
    expect(d.position).toBe(3);
    const own = d.mentions.find((m) => m.own)!;
    expect(own.count).toBe(2);
    expect(own.firstOffset).toBe(text.indexOf("AlphaNote"));
    const ws = d.mentions.find((m) => m.domain === "gammanest.example")!;
    expect(ws.position).toBe(1);
    // "Margin" and "Deltabarn" are both names of deltabarn.example, counted twice but positioned once.
    const bd = d.mentions.find((m) => m.domain === "deltabarn.example")!;
    expect(bd).toMatchObject({ count: 2, position: 2 });
  });

  it("marks citations by domain and subdomain, including alias domains", () => {
    const cites = extractCitations("", [{ url: "https://www.alphanote.test/scenes" }, { url: "https://blog.deltabarn.example/post" }]);
    const d = detect("No brands named here.", cites, brands);
    expect(d.mentioned).toBe(false);
    expect(d.position).toBeNull();
    expect(d.cited).toBe(true);
    expect(d.mentions.find((m) => m.domain === "deltabarn.example")!.cited).toBe(true);
    expect(d.mentions.find((m) => m.domain === "gammanest.example")!.cited).toBe(false);
  });

  it("does not count a lookalike domain as a citation", () => {
    const d = detect("", extractCitations("", [{ url: "https://notalphanote.test/" }]), brands);
    expect(d.cited).toBe(false);
  });

  it("splits text into highlight segments", () => {
    const t = "Use AlphaNote or Gammanest.";
    const segs = segments(t, findSpans(t, brands));
    expect(segs.map((s) => s.text)).toEqual(["Use ", "AlphaNote", " or ", "Gammanest", "."]);
    expect(segs[1].span?.own).toBe(true);
    expect(segs[3].span?.own).toBe(false);
  });
});

describe("own brand from the project name", () => {
  const bpl = ownBrand({ domain: "bplandscapes.example", name: "Blue Pine Landscaping" });

  it("matches the project name when it differs from the domain", () => {
    expect(bpl.names).toContain("Blue Pine Landscaping");
    expect(bpl.name).toBe("Blue Pine Landscaping");
    const d = detect("For lawn care, try blue pine landscaping or a local pro.", [], [bpl, gammanest]);
    expect(d.mentioned).toBe(true);
    expect(d.position).toBe(1);
  });

  it("still matches the domain name", () => {
    expect(detect("BPLandscapes did our yard.", [], [bpl]).mentioned).toBe(true);
  });

  it("drops a trailing parenthetical and empty names", () => {
    expect(projectNameAlias("Alphanote (main site)")).toBe("Alphanote");
    expect(projectNameAlias("  ")).toBeNull();
    expect(projectNameAlias(null)).toBeNull();
  });

  it("doesn't duplicate a name equal to the domain label, and keeps a user alias as display name", () => {
    const b = ownBrand({ domain: "alphanote.example", name: "Alphanote" });
    expect(b.names).toEqual(["alphanote"]);
    expect(b.name).toBe("Alphanote");
    const c = ownBrand({ domain: "deltabarn.example", name: "Deltabarn Apps" }, ["Margin"]);
    expect(c.name).toBe("Margin");
    expect(c.names).toEqual(expect.arrayContaining(["Margin", "Deltabarn Apps"]));
  });

  it("shows the project name as typed when it contains the domain label", () => {
    const b = ownBrand({ domain: "betaweb.example", name: "Beta Web Design" });
    expect(b.name).toBe("Beta Web Design");
    expect(b.names).toEqual(expect.arrayContaining(["betaweb", "Beta Web Design"]));
    expect(ownBrand({ domain: "alphanote.test", name: "AlphaNote" }).name).toBe("AlphaNote");
    expect(ownBrand({ domain: "alphanote.test", name: "alphanote.test" }).name).toBe("Alphanote");
  });
});

describe("branded prompts and sites", () => {
  it("calls a prompt branded when it names us by any name", () => {
    const own = ownBrand({ domain: "bpl.example", name: "Blue Pine Landscaping" }, ["BPL"]);
    expect(namesBrand("Is Blue Pine Landscaping any good?", own)).toBe(true);
    expect(namesBrand("bpl.example reviews", own)).toBe(true);
    expect(namesBrand("best landscapers near Windham", own)).toBe(false);
    expect(namesBrand("Is AlphaNote worth it?", us)).toBe(true);
    expect(namesBrand("best mac journal", us)).toBe(false);
  });

  it("groups hosts by site", () => {
    expect(siteOf("support.apple.com")).toBe("apple.com");
    expect(siteOf("www.shop.foo.co.uk")).toBe("foo.co.uk");
    expect(siteOf("plainpad.github.io")).toBe("plainpad.github.io");
    expect(siteOf("epsilonapps.example")).toBe("epsilonapps.example");
  });
});
