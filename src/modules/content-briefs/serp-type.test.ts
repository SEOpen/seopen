import { describe, expect, it } from "vitest";
import { classifyResult, serpMix, templateFit } from "./serp-type";
import { SERP_TYPE_LABEL } from "./types";

const r = (title: string, url = "https://site.example/page", type = "organic") => ({ type, url, domain: new URL(url).hostname, title });

describe("classifyResult", () => {
  it("reads the page type from the result", () => {
    expect(classifyResult(r("Ambient sounds", "https://www.youtube.com/watch?v=1")).type).toBe("video");
    expect(classifyResult(r("Anything", "https://site.example/v", "video")).type).toBe("video");
    expect(classifyResult(r("Notion vs Obsidian: which to pick")).type).toBe("comparison");
    expect(classifyResult(r("7 Mailchimp alternatives")).type).toBe("comparison");
    expect(classifyResult(r("Mortgage calculator")).type).toBe("tool");
    expect(classifyResult(r("12 best garden planners")).type).toBe("list");
    expect(classifyResult(r("Free garden planner tool")).type).toBe("tool");
    expect(classifyResult(r("The 12 best rose varieties")).type).toBe("list");
    expect(classifyResult(r("Best roses for shade")).type).toBe("list");
    expect(classifyResult(r("Rose bush", "https://www.amazon.com/dp/B000")).type).toBe("product");
    expect(classifyResult(r("Pricing", "https://site.example/pricing")).type).toBe("product");
    expect(classifyResult(r("How to prune roses")).type).toBe("guide");
    expect(classifyResult(r("Pruning", "https://site.example/blog/pruning")).type).toBe("guide");
    expect(classifyResult(r("Fernhill Gardens", "https://fernhill.example/")).type).toBe("product");
  });

  it("reads numbered and best-of lists of tools as lists, a single tool page as a tool", () => {
    expect(classifyResult(r("10 best rank checkers")).type).toBe("list");
    expect(classifyResult(r("10 Best Backlink Checker Tools in 2026")).type).toBe("list");
    expect(classifyResult(r("Best backlink checker tools")).type).toBe("list");
    expect(classifyResult(r("Top 7 mortgage calculator apps")).type).toBe("list");
    expect(classifyResult(r("Best free mortgage calculator")).type).toBe("tool");
    expect(classifyResult(r("Free Backlink Checker by SEOpen")).type).toBe("tool");
  });

  it("reads a blog's best-of or tools list from its address, even when its title names one tool (QA B12)", () => {
    expect(classifyResult(r("Free Backlink Checker", "https://madeup-seo-blog.com/best-backlink-checker/")).type).toBe("list");
    expect(classifyResult(r("Free Backlink Checker: check any site", "https://madeup-tips.com/blog/free-backlink-checker-tools/")).type).toBe("list");
    expect(classifyResult(r("Backlink checker", "https://madeup-webguide.com/best-free-backlink-checker-tools")).type).toBe("list");
    // A tools section and a single tool page stay tools.
    expect(classifyResult(r("Backlink checker", "https://getseopen.com/tools/backlink-checker")).type).toBe("tool");
    expect(classifyResult(r("Mortgage calculator", "https://site.example/tools/")).type).toBe("tool");
    expect(classifyResult(r("Top rated roofers", "https://roof.example/top-rated-roofing/")).type).not.toBe("list");
  });

  it("gives no page type to a result with no address", () => {
    expect(classifyResult({ type: "organic", url: null, domain: null, title: null })).toEqual({ type: null, why: "no rule matched" });
  });

  it("reads a local search's directory lists and business pages, from a Salem top 10 Google hid the links of", () => {
    const shown = (title: string, breadcrumb: string) => r(title, `https://${breadcrumb.replace(" › ", "/")}`);
    expect(classifyResult(shown("Top Web Designing Companies in Salem 2026", "www.directory-one.example › top-web-designing-compa")).type).toBe("list");
    expect(classifyResult(shown("Top Web Design Firms in Salem for Business Growth", "www.agency-one.example/blog › best-web-d")).type).toBe("list");
    expect(classifyResult(shown("Salem Professional Web Consulting Services", "agency-two.example › professional-web-co")).type).toBe("product");
    expect(classifyResult(shown("Salem eCommerce Website Designers Firm", "agency-two.example › ecommerce-website-")).type).toBe("product");
    expect(classifyResult(shown("Salem Advertising Web Page Designer Specialists", "agency-two.example › advertising-web-pag")).type).toBe("product");
    expect(classifyResult(r("Emergency plumber near me")).type).toBe("product");
    // An article about choosing one stays an article.
    expect(classifyResult(r("How to choose a web design company")).type).toBe("guide");
    // A tool for designers isn't a service.
    expect(classifyResult(r("Figma for designers", "https://www.figma.com/designers")).type).toBeNull();
  });

  it("leaves a result no rule matches unclassified", () => {
    expect(classifyResult(r("Roses", "https://site.example/roses"))).toEqual({ type: null, why: "no rule matched" });
  });
});

describe("serpMix", () => {
  const of = (types: (string | null)[]) => types.map((type, i) => ({ type: type as never, url: `https://s${i}.example/` }));

  it("names the dominant type with the URLs behind each", () => {
    const mix = serpMix(of(["guide", "guide", "guide", "guide", "guide", "guide", "list", "list", "video", null]));
    expect(mix).toMatchObject({ dominant: "guide", agree: 6, total: 10, warning: null });
    expect(mix.byType.map((g) => [g.type, g.urls.length])).toEqual([["guide", 6], ["list", 2], ["video", 1]]);
  });

  it("warns when fewer than 6 of 10 agree", () => {
    const mix = serpMix(of(["guide", "guide", "guide", "guide", "guide", "list", "list", "video", null, null]));
    expect(mix.dominant).toBe("guide");
    expect(mix.warning).toContain("Only 5 of 10");
  });

  it("says no pattern, not \"only 1 share\", when under two results share a type (QA B11)", () => {
    const mix = serpMix(of(["tool", "list", null, null, null, null, null, null, null]));
    expect(mix.dominant).toBeNull();
    expect(mix.warning).toBe("Only 2 of 9 results could be given a page type, and no two share one, so there's no pattern to follow. Read the results before choosing one.");
    expect(serpMix(of(["tool", "list"])).warning).toBe("No two of the 2 results share a page type, so there's no pattern to follow. Read the results before choosing one.");
    expect(serpMix(of(["tool"])).warning).toBeNull();
    expect(serpMix(of([null, null])).warning).toBe("None of the 2 results could be given a page type, so there's no pattern to follow. Read the results before choosing one.");
  });

  it("has no dominant type on a tie", () => {
    expect(serpMix(of(["guide", "list"])).dominant).toBeNull();
  });

  it("says nothing about an empty top 10", () => {
    expect(serpMix([])).toMatchObject({ dominant: null, total: 0, warning: null });
  });
});

describe("templateFit", () => {
  const label = (t: keyof typeof SERP_TYPE_LABEL) => SERP_TYPE_LABEL[t];
  it("says when the page type doesn't match what ranks", () => {
    expect(templateFit("pricing", "guide", label)).toContain("Most of the top 10 are articles");
    expect(templateFit("guide", "product", label)).toContain("product or service pages");
    expect(templateFit("alternatives", "list", label)).toBeNull();
    expect(templateFit("guide", null, label)).toBeNull();
  });
});
