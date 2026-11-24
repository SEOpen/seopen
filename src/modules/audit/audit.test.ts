import { describe, expect, it } from "vitest";
import { diffCrawls } from "./diff";
import { detectIssues, type CrawlInput, type CrawledPage } from "./issues";
import { healthScore, scoreBand, severityCounts } from "./score";
import { ISSUE_LIST, ISSUES, PAGE_ERROR_CODES } from "./taxonomy";
import { acceptLanguage, crawlFailureReason, crawlTaskBody, estimateCrawlCost, LIGHTHOUSE_PRICE_USD, pageRow, PRICE_PER_PAGE, priceText, toContentMatch, toCrawledPage, toSiteInfo } from "./transform";
import type { DfsPage, DfsSummary } from "./types";

function page(over: Partial<CrawledPage> = {}): CrawledPage {
  return {
    url: "https://example.com/a",
    statusCode: 200,
    resourceType: "html",
    location: null,
    title: "A useful page about things",
    description: "desc",
    h1s: ["Things"],
    canonical: "https://example.com/a",
    depth: 1,
    wordCount: 800,
    internalLinksIn: 5,
    loadTimeMs: 300,
    waitingTimeMs: 100,
    sizeBytes: 40_000,
    duplicateTitle: false,
    duplicateDescription: false,
    duplicateContent: false,
    checks: { canonical: true, has_micromarkup: true, seo_friendly_url: true },
    ...over,
  };
}

function input(over: Partial<CrawlInput> = {}): CrawlInput {
  return {
    target: "example.com",
    pages: [],
    links: [],
    resources: [],
    duplicates: [],
    contentMatches: [],
    nonIndexable: [],
    site: { checks: { sitemap: true, robots_txt: true }, validCertificate: true, certificateExpires: null, notFoundStatus: 404, altHostStatus: 301 },
    now: new Date("2026-10-29T00:00:00Z"),
    ...over,
  };
}

const codes = (rows: { code: string }[]) => rows.map((r) => r.code).sort();

describe("taxonomy", () => {
  it("has unique codes with why and fix text", () => {
    expect(new Set(ISSUE_LIST.map((d) => d.code)).size).toBe(ISSUE_LIST.length);
    for (const d of ISSUE_LIST) {
      expect(d.why.length).toBeGreaterThan(20);
      expect(d.fix.length).toBeGreaterThan(10);
    }
  });

  it("never names the data vendor in what customers read", () => {
    for (const d of ISSUE_LIST) expect(`${d.title} ${d.why} ${d.fix} ${d.detailLabel ?? ""}`).not.toMatch(/dataforseo/i);
  });
});

describe("PAGE_ERROR_CODES", () => {
  it("has the errors that name a page, not site-wide errors or broken files", () => {
    expect(PAGE_ERROR_CODES).toContain("http-4xx");
    expect(PAGE_ERROR_CODES).toContain("missing-title");
    expect(PAGE_ERROR_CODES).not.toContain("broken-resources");
    expect(PAGE_ERROR_CODES).not.toContain("invalid-certificate");
    for (const code of PAGE_ERROR_CODES) expect(ISSUES[code].severity).toBe("error");
  });
});

describe("detectIssues", () => {
  it("reports nothing for a clean page", () => {
    expect(detectIssues(input({ pages: [page()] }))).toEqual([]);
  });

  it("maps status codes", () => {
    const rows = detectIssues(
      input({
        pages: [
          page({ url: "https://example.com/404", statusCode: 404 }),
          page({ url: "https://example.com/500", statusCode: 503 }),
          page({ url: "https://example.com/tmp", statusCode: 302, location: "https://example.com/new", resourceType: "redirect" }),
          page({ url: "https://example.com/old", statusCode: 301, location: "https://example.com/new", resourceType: "redirect" }),
        ],
      }),
    );
    expect(codes(rows)).toEqual(["http-4xx", "http-5xx", "permanent-redirect", "temporary-redirect"]);
    expect(rows.find((r) => r.code === "temporary-redirect")?.detail).toBe("302 → https://example.com/new");
  });

  it("flags URLs the crawler got no response from", () => {
    const rows = detectIssues(input({ pages: [page({ url: "http://example.com/", statusCode: 0, resourceType: "broken" })] }));
    expect(codes(rows)).toEqual(["unreachable"]);
  });

  it("skips content checks on error pages", () => {
    const rows = detectIssues(input({ pages: [page({ statusCode: 404, checks: { no_title: true }, wordCount: 3 })] }));
    expect(codes(rows)).toEqual(["http-4xx"]);
  });

  it("maps provider checks with the right polarity", () => {
    const rows = detectIssues(
      input({
        pages: [
          page({
            title: "x".repeat(74),
            checks: { title_too_long: true, no_description: true, canonical: false, has_micromarkup: false, seo_friendly_url: true, no_h1_tag: false },
          }),
        ],
      }),
    );
    expect(codes(rows)).toEqual(["missing-canonical", "missing-description", "title-too-long"]);
    expect(rows.find((r) => r.code === "title-too-long")?.detail).toBe("74 characters");
  });

  it("names the images with no alt attribute that the audit's fetch found", () => {
    const rows = detectIssues(
      input({
        pages: [
          page({ url: "https://example.com/a", checks: { no_image_alt: true }, imagesWithoutAlt: { missing: 2, named: ["/a.png", "/b.png"] } }),
          page({ url: "https://example.com/b", checks: { no_image_alt: true } }),
        ],
      }),
    );
    const alt = rows.filter((r) => r.code === "missing-alt");
    expect(alt.map((r) => [r.url, r.detail])).toEqual([
      ["https://example.com/a", "/a.png, /b.png"],
      ["https://example.com/b", null],
    ]);
  });

  it("names the text share and the render-blocking files a page was flagged for (QA B16)", () => {
    const rows = detectIssues(
      input({
        pages: [
          page({ url: "https://example.com/a", checks: { low_content_rate: true, has_render_blocking_resources: true }, textRate: 0.0634, renderBlocking: { scripts: 2, stylesheets: 1 } }),
          page({ url: "https://example.com/b", checks: { low_content_rate: true, has_render_blocking_resources: true } }),
        ],
      }),
    );
    const of = (code: string) => rows.filter((r) => r.code === code).map((r) => [r.url, r.detail]);
    expect(of("low-text-ratio")).toEqual([["https://example.com/a", "6.3% of the HTML is text"], ["https://example.com/b", null]]);
    expect(of("render-blocking")).toEqual([["https://example.com/a", "2 scripts, 1 stylesheet"], ["https://example.com/b", null]]);
  });

  it("applies our own thresholds", () => {
    const rows = detectIssues(
      input({
        pages: [
          page({
            url: `https://example.com/${"long-".repeat(45)}`,
            wordCount: 120,
            h1s: ["One", "Two"],
            title: "One",
            depth: 5,
            internalLinksIn: 1,
          }),
          page({ url: "https://example.com/orphan", internalLinksIn: 0, depth: 2 }),
          page({ url: "https://example.com/", internalLinksIn: 0, depth: 0 }),
        ],
      }),
    );
    expect(codes(rows)).toEqual(["deep-page", "long-url", "multiple-h1", "orphan-page", "single-inlink", "thin-content", "title-equals-h1"]);
  });

  it("uses duplicate groups and falls back to page flags", () => {
    const grouped = detectIssues(
      input({
        pages: [page({ url: "https://example.com/1" }), page({ url: "https://example.com/2" })],
        duplicates: [{ kind: "title", value: "Same", urls: ["https://example.com/1", "https://example.com/2"] }],
      }),
    );
    expect(grouped.filter((r) => r.code === "duplicate-title").map((r) => r.detail)).toEqual(["Same", "Same"]);

    const flagged = detectIssues(input({ pages: [page({ duplicateDescription: true, description: "Shared" })] }));
    expect(flagged).toEqual([{ code: "duplicate-description", url: "https://example.com/a", detail: "Shared" }]);
  });

  it("groups broken and nofollow links by source page", () => {
    const rows = detectIssues(
      input({
        links: [
          { fromUrl: "https://example.com/a", toUrl: "https://example.com/gone", direction: "internal", dofollow: true, isBroken: true },
          { fromUrl: "https://example.com/a", toUrl: "https://example.com/gone2", direction: "internal", dofollow: true, isBroken: true },
          { fromUrl: "https://example.com/a", toUrl: "https://other.com/x", direction: "external", dofollow: true, isBroken: true },
          { fromUrl: "https://example.com/b", toUrl: "https://example.com/c", direction: "internal", dofollow: false, isBroken: false },
          { fromUrl: "https://example.com/b", toUrl: "https://other.com/ad", direction: "external", dofollow: false, isBroken: false },
        ],
      }),
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { code: "broken-internal-links", url: "https://example.com/a", detail: "https://example.com/gone (+1 more)" },
        { code: "broken-external-links", url: "https://example.com/a", detail: "https://other.com/x" },
        { code: "nofollow-internal", url: "https://example.com/b", detail: "https://example.com/c" },
      ]),
    );
    expect(rows).toHaveLength(3);
  });

  it("names the closest match on a page flagged for similar content", () => {
    const rows = detectIssues(
      input({
        pages: [page({ url: "https://example.com/1", duplicateContent: true }), page({ url: "https://example.com/2", duplicateContent: true }), page({ url: "https://example.com/3", duplicateContent: true })],
        contentMatches: [
          { url: "https://example.com/1", matchUrl: "https://example.com/2", similarity: 7, more: 0 },
          { url: "https://example.com/2", matchUrl: "https://example.com/1", similarity: 8, more: 2 },
        ],
      }),
    ).filter((r) => r.code === "duplicate-content");
    expect(rows.map((r) => r.detail)).toEqual(["https://example.com/2 (7 of 10)", "https://example.com/1 (8 of 10, +2 more)", null]);
  });

  describe("nofollow links to pages kept out of search", () => {
    const nofollow = (toUrl: string, isBroken = false) => ({ fromUrl: "https://example.com/a", toUrl, direction: "internal", dofollow: false, isBroken });

    it.each(["robots_txt", "meta_tag", "http_header"])("drops the finding when the target is out of search by %s", (reason) => {
      const rows = detectIssues(input({ links: [nofollow("https://example.com/account/")], nonIndexable: [{ url: "https://example.com/account", reason }] }));
      expect(rows.filter((r) => r.code === "nofollow-internal")).toEqual([]);
    });

    it.each(["attribute", "too_many_redirects", null])("keeps the finding when the target's reason is %s", (reason) => {
      const rows = detectIssues(input({ links: [nofollow("https://example.com/c")], nonIndexable: [{ url: "https://example.com/c", reason }] }));
      expect(rows.filter((r) => r.code === "nofollow-internal")).toHaveLength(1);
    });

    it("lists only the targets that can still rank", () => {
      const rows = detectIssues(input({ links: [nofollow("https://example.com/account"), nofollow("https://example.com/c")], nonIndexable: [{ url: "https://example.com/account", reason: "robots_txt" }] }));
      expect(rows.find((r) => r.code === "nofollow-internal")?.detail).toBe("https://example.com/c");
    });

    it("still reports a broken link to a page out of search", () => {
      const rows = detectIssues(input({ links: [nofollow("https://example.com/account", true)], nonIndexable: [{ url: "https://example.com/account", reason: "robots_txt" }] }));
      expect(rows.filter((r) => r.code === "broken-internal-links")).toHaveLength(1);
    });

    it("is a notice, so one site-wide link can't move a site's band", () => {
      expect(ISSUES["nofollow-internal"].severity).toBe("notice");
    });
  });

  describe("toContentMatch", () => {
    const of = (similarity: number, url: string) => ({ similarity, page: [{ url }] });
    const self = "https://example.com/a";

    it("picks the highest score in any order and counts the rest", () => {
      expect(toContentMatch({ url: self, total_count: 3, pages: [of(6, "https://example.com/b"), of(9, "https://example.com/c"), of(7, "https://example.com/d")] })).toEqual({ url: self, matchUrl: "https://example.com/c", similarity: 9, more: 2 });
    });

    it("never matches a page with itself", () => {
      expect(toContentMatch({ url: self, total_count: 2, pages: [of(10, self), of(6, "https://example.com/b")] })).toEqual({ url: self, matchUrl: "https://example.com/b", similarity: 6, more: 0 });
      expect(toContentMatch({ url: self, total_count: 1, pages: [of(10, self)] })).toBeNull();
    });

    it("counts similar pages beyond the ones returned", () => {
      expect(toContentMatch({ url: self, total_count: 150, pages: [of(6, "https://example.com/b")] })?.more).toBe(149);
    });

    it("handles an empty answer", () => {
      expect(toContentMatch(undefined)).toBeNull();
      expect(toContentMatch({ url: self, total_count: 0, pages: null })).toBeNull();
    });
  });

  it("reports site-wide problems against the homepage", () => {
    const rows = detectIssues(
      input({
        site: {
          checks: { sitemap: false, robots_txt: false },
          validCertificate: false,
          certificateExpires: "2026-11-05 00:00:00 +00:00",
          notFoundStatus: 200,
          altHostStatus: 200,
        },
      }),
    );
    expect(codes(rows)).toEqual(["certificate-expiring", "host-not-canonical", "invalid-certificate", "no-robots-txt", "no-sitemap", "soft-404"]);
    expect(new Set(rows.map((r) => r.url))).toEqual(new Set(["https://example.com/"]));
  });

  it("ignores the keyword part of the URL-friendliness check", () => {
    const keywordOnly = detectIssues(input({ pages: [page({ checks: { canonical: true, seo_friendly_url: false, seo_friendly_url_keywords_check: false, seo_friendly_url_characters_check: true, seo_friendly_url_dynamic_check: true } })] }));
    expect(keywordOnly).toEqual([]);
    const params = detectIssues(input({ pages: [page({ checks: { canonical: true, seo_friendly_url_dynamic_check: false } })] }));
    expect(codes(params)).toEqual(["unfriendly-url"]);
  });

  it("emits each (code, url) once", () => {
    const rows = detectIssues(input({ pages: [page({ checks: { canonical_to_redirect: true, canonical_chain: true } })] }));
    expect(rows.filter((r) => r.code === "canonical-to-redirect")).toHaveLength(1);
  });
});

describe("healthScore", () => {
  const urls = ["https://example.com/1", "https://example.com/2", "https://example.com/3", "https://example.com/4"];

  it("is 100 with no issues, and 100 for an empty crawl", () => {
    expect(healthScore(urls, []).score).toBe(100);
    expect(healthScore([], []).score).toBe(100);
  });

  it("averages per-page penalties by severity", () => {
    // Page 1 loses 25 (error), page 2 loses 8 (warning), page 3 loses 2 (notice), page 4 is clean.
    const r = healthScore(urls, [
      { code: "http-4xx", url: urls[0] },
      { code: "missing-description", url: urls[1] },
      { code: "multiple-h1", url: urls[2] },
    ]);
    // (75 + 92 + 98 + 100) / 4 = 91.25, rounded to one decimal.
    expect(r.score).toBe(91.3);
    expect(r).toMatchObject({ errors: 1, warnings: 1, notices: 1, pagesWithIssues: 3 });
  });

  it("counts each distinct issue on a page and floors pages at zero", () => {
    const errors = ["http-4xx", "missing-title", "duplicate-title", "duplicate-content", "redirect-chain"];
    const r = healthScore([urls[0]], errors.map((code) => ({ code, url: urls[0] })));
    expect(r.score).toBe(0);
  });

  it("subtracts capped site-wide penalties", () => {
    const home = "https://example.com/";
    expect(healthScore(urls, [{ code: "invalid-certificate", url: home }]).score).toBe(95);
    const many = ["invalid-certificate", "no-sitemap", "soft-404", "host-not-canonical", "certificate-expiring", "no-robots-txt"];
    // 5 + 2 + 2 + 2 + 2 + 0.5 = 13.5, under the cap of 20.
    expect(healthScore(urls, many.map((code) => ({ code, url: home }))).score).toBe(86.5);
  });

  it("ignores unknown codes", () => {
    expect(healthScore(urls, [{ code: "made-up", url: urls[0] }]).score).toBe(100);
  });

  it("bands scores", () => {
    expect(scoreBand(95).tone).toBe("good");
    expect(scoreBand(80).tone).toBe("warn");
    expect(scoreBand(40).tone).toBe("bad");
  });
});

describe("severityCounts", () => {
  it("counts issue rows by today's severity, so a check that changed severity moves with it", () => {
    // nofollow-internal was a warning when older crawls were stored; it's a notice now.
    expect(ISSUES["nofollow-internal"].severity).toBe("notice");
    expect(severityCounts([{ code: "http-4xx", n: 2 }, { code: "missing-description", n: 10 }, { code: "nofollow-internal", n: 58 }, { code: "render-blocking", n: 58 }, { code: "made-up", n: 4 }])).toEqual({ errors: 2, warnings: 10, notices: 116 });
  });

  it("agrees with the counts healthScore stores", () => {
    const rows = [{ code: "http-4xx", url: "https://example.com/1" }, { code: "missing-description", url: "https://example.com/1" }, { code: "multiple-h1", url: "https://example.com/2" }];
    const { errors, warnings, notices } = healthScore(["https://example.com/1", "https://example.com/2"], rows);
    expect(severityCounts(rows.map((r) => ({ code: r.code, n: 1 })))).toEqual({ errors, warnings, notices });
  });
});

describe("diffCrawls", () => {
  it("finds new and fixed URLs per code", () => {
    const d = diffCrawls(
      [
        { code: "http-4xx", url: "/a" },
        { code: "http-4xx", url: "/b" },
        { code: "missing-description", url: "/c" },
      ],
      [
        { code: "http-4xx", url: "/b" },
        { code: "http-4xx", url: "/d" },
        { code: "multiple-h1", url: "/e" },
      ],
    );
    const by = Object.fromEntries(d.codes.map((c) => [c.code, c]));
    expect(by["http-4xx"]).toMatchObject({ before: 2, after: 2, added: ["/d"], fixed: ["/a"] });
    expect(by["missing-description"]).toMatchObject({ before: 1, after: 0, added: [], fixed: ["/c"] });
    expect(by["multiple-h1"]).toMatchObject({ before: 0, after: 1, added: ["/e"], fixed: [] });
    expect(d.totals).toEqual({ before: 3, after: 3, added: 2, fixed: 2 });
  });

  it("sorts errors first", () => {
    const d = diffCrawls([], [
      { code: "multiple-h1", url: "/a" },
      { code: "missing-description", url: "/a" },
      { code: "http-5xx", url: "/a" },
    ]);
    expect(d.codes.map((c) => c.severity)).toEqual(["error", "warning", "notice"]);
  });

  it("treats identical crawls as unchanged", () => {
    const rows = [{ code: "http-4xx", url: "/a" }];
    expect(diffCrawls(rows, rows).totals).toEqual({ before: 1, after: 1, added: 0, fixed: 0 });
  });
});

describe("transform", () => {
  it("estimates crawl cost from the per-page rate", () => {
    expect(estimateCrawlCost({ maxPages: 500, enableJavascript: false, loadResources: true })).toBeCloseTo(0.225);
    expect(estimateCrawlCost({ maxPages: 500, enableJavascript: false, loadResources: false })).toBeCloseTo(0.075);
    expect(estimateCrawlCost({ maxPages: 100, enableJavascript: true, loadResources: true })).toBeCloseTo(0.15);
  });

  it("writes unit prices the way the docs do, without rounding", () => {
    expect(priceText(PRICE_PER_PAGE.resources)).toBe("$0.00045");
    expect(priceText(PRICE_PER_PAGE.javascript)).toBe("$0.0015");
    expect(priceText(LIGHTHOUSE_PRICE_USD)).toBe("$0.005");
  });

  it("builds the task body with our user agent and language", () => {
    const body = crawlTaskBody({ target: "example.com", maxPages: 50, enableJavascript: true, loadResources: false, tag: "t", acceptLanguage: acceptLanguage("en", "US") });
    expect(body).toMatchObject({ target: "example.com", max_crawl_pages: 50, enable_javascript: true, load_resources: true, accept_language: "en-US" });
    expect(body.custom_user_agent).toContain("SEOpen");
  });

  it("maps a provider page and keeps only true checks", () => {
    const raw: DfsPage = {
      resource_type: "html",
      status_code: 200,
      location: null,
      url: "https://example.com/",
      meta: {
        title: "Home",
        description: null,
        canonical: null,
        htags: { h1: [" Welcome "] },
        internal_links_count: 12,
        external_links_count: 3,
        inbound_links_count: 0,
        title_length: 4,
        description_length: 0,
        content: { plain_text_word_count: 321, plain_text_rate: 0.1 },
      },
      page_timing: { duration_time: 412.6, waiting_time: 90 },
      onpage_score: 88.5,
      click_depth: 0,
      size: 50_000,
      checks: { no_description: true, is_https: true, canonical: false, no_title: null },
    };
    expect(toCrawledPage(raw)).toMatchObject({ h1s: ["Welcome"], wordCount: 321, internalLinksIn: 0, depth: 0, textRate: 0.1 });
    expect(toCrawledPage(raw).renderBlocking).toBeUndefined();
    expect(toCrawledPage({ ...raw, meta: { ...raw.meta!, render_blocking_scripts_count: 3, render_blocking_stylesheets_count: 0 } }).renderBlocking).toEqual({ scripts: 3, stylesheets: 0 });
    const row = pageRow(raw);
    expect(row).toMatchObject({ internalLinksOut: 12, externalLinksOut: 3, loadTimeMs: 413, h1: "Welcome" });
    expect(row.checks).toEqual(["is_https", "no_description"]);
  });

  it("reads site info from the summary", () => {
    const s = {
      crawl_progress: "finished",
      crawl_status: null,
      page_metrics: null,
      domain_info: {
        name: "example.com",
        cms: null,
        ip: null,
        server: null,
        crawl_start: null,
        crawl_end: null,
        total_pages: 10,
        ssl_info: { valid_certificate: true, certificate_issuer: "X", certificate_expiration_date: "2027-01-01" },
        checks: { sitemap: true },
        page_not_found_status_code: 404,
        www_redirect_status_code: 301,
      },
    } as unknown as DfsSummary;
    expect(toSiteInfo(s)).toEqual({ checks: { sitemap: true }, validCertificate: true, certificateExpires: "2027-01-01", notFoundStatus: 404, altHostStatus: 301 });
    expect(toSiteInfo(null).validCertificate).toBeNull();
  });
});

describe("crawlFailureReason", () => {
  const summary = (ext: string | null, crawled: number) =>
    ({ crawl_progress: "finished", crawl_status: { max_crawl_pages: 20, pages_in_queue: 0, pages_crawled: crawled }, domain_info: { extended_crawl_status: ext }, page_metrics: null }) as unknown as DfsSummary;

  it("explains an unreachable site (real response from a client site)", () => {
    expect(crawlFailureReason(summary("site_unreachable", 1))).toMatch(/could not reach the site.*site_unreachable/);
  });

  it("passes normal crawls", () => {
    expect(crawlFailureReason(summary("no_errors", 50))).toBeNull();
    expect(crawlFailureReason(summary(null, 50))).toBeNull();
  });

  it("fails unknown statuses only when nothing was crawled", () => {
    expect(crawlFailureReason(summary("something_new", 0))).toBe("The crawl stopped: something new.");
    expect(crawlFailureReason(summary("something_new", 10))).toBeNull();
  });
});

describe("every mapped code exists", () => {
  it("detector codes are all in the taxonomy", () => {
    // detectIssues throws on unknown codes; a page tripping every mapped check exercises all of them.
    const all = Object.fromEntries(
      [
        "no_title", "no_description", "title_too_long", "title_too_short", "duplicate_meta_tags", "no_h1_tag", "low_content_rate",
        "no_image_alt", "lorem_ipsum", "https_to_http_links", "high_waiting_time", "high_loading_time", "no_content_encoding",
        "large_page_size", "size_greater_than_3mb", "frame", "no_doctype", "has_meta_refresh_redirect", "redirect_chain",
        "canonical_to_broken", "canonical_to_redirect", "recursive_canonical", "has_micromarkup_errors", "no_encoding_meta_tag",
        "has_render_blocking_resources", "has_links_to_redirects", "low_readability_rate", "no_favicon",
      ].map((k) => [k, true]),
    );
    const rows = detectIssues(input({ pages: [page({ checks: { ...all, canonical: false, seo_friendly_url_characters_check: false } })] }));
    for (const r of rows) expect(ISSUES[r.code]).toBeDefined();
    expect(rows.length).toBeGreaterThan(25);
  });
});
