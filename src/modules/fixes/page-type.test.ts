import { describe, expect, it } from "vitest";
import { classifyRow, mismatchLine, ownPageType, pageTypes, type ResultInput } from "./page-type";

const row = (title: string, url: string | null, extra: Partial<ResultInput> = {}): ResultInput => ({ type: "organic", url, domain: url ? new URL(url).hostname : null, title, originOnly: false, breadcrumb: null, ...extra });
const audit = (text: string) => ({ text, from: "from SEOpen's latest site audit" });

describe("classifyRow", () => {
  it("reads a hidden address from Google's display path", () => {
    expect(classifyRow(row("Our picks this year", "https://www.sitepoint.com/", { originOnly: true, breadcrumb: "blog › link-tools" }))).toEqual({ type: "list", why: "address reads as a best-of list or a list of tools, reading the address from Google's display path" });
  });

  it("doesn't call a hidden page the home page", () => {
    // The display path was cut short, so the address says nothing, but it isn't the home page.
    expect(classifyRow(row("Acme", "https://acme.example/", { originOnly: true, breadcrumb: "products › …" })).type).toBeNull();
    // The daily rank check keeps only the origin, without saying the address was hidden.
    expect(classifyRow(row("Acme", "https://acme.example/", { originOnly: "unknown" }))).toEqual({ type: null, why: "only the site's address was saved, so it may not be the home page" });
    // Google shows a bare origin for a home page.
    expect(classifyRow(row("Acme", "https://acme.example/", { originOnly: true })).type).toBe("product");
  });

  it("leaves a result with no address untyped (QA B11)", () => {
    expect(classifyRow({ type: "organic", url: null, domain: null, title: "Backlink Checker", originOnly: false, breadcrumb: null })).toEqual({ type: null, why: "Google gave no address for this result" });
  });

  it("keeps content briefs' rules for a plain result", () => {
    expect(classifyRow(row("Free Backlink Checker", "https://ahrefs.com/backlink-checker"))).toEqual({ type: "tool", why: "title or address names a tool" });
  });
});

describe("pageTypes", () => {
  it("counts organic and video results only, the first 10", () => {
    const rows = [{ ...row("People also ask", null), type: "people_also_ask" }, ...Array.from({ length: 11 }, (_, i) => row(`Checker ${i}`, `https://s${i}.example/checker`))];
    const { kinds, mix } = pageTypes(rows);
    expect(kinds[0]).toBeNull();
    expect(mix).toMatchObject({ dominant: "tool", agree: 10, total: 10, warning: null });
  });
});

describe("ownPageType", () => {
  it("doesn't trust a title that names a tool on a page whose address doesn't", () => {
    // /features/backlinks as titled on main (src/content/pages.ts): a feature page that reads as a tool.
    const own = ownPageType("https://getseopen.com/features/backlinks", audit("Backlink checker and explorer: who links to you"));
    expect(own).toEqual({
      type: "tool",
      why: "its title “Backlink checker and explorer: who links to you” (from SEOpen's latest site audit) names a tool, but its address doesn't show it is one, so it may be a page about a tool",
      reliable: false,
    });
    const tools = pageTypes(Array.from({ length: 10 }, (_, i) => row(i < 7 ? "Free backlink checker" : "How backlinks work", `https://s${i}.example/x`))).mix;
    expect(mismatchLine(tools, own)).toBeNull();
    const guides = pageTypes(Array.from({ length: 10 }, (_, i) => row("How backlinks work", `https://s${i}.example/x`))).mix;
    expect(mismatchLine(guides, own)).toBeNull();
  });

  it("trusts a title and address that agree, or a title only an article would have", () => {
    expect(ownPageType("https://x.example/pricing", audit("Pricing"))).toMatchObject({ type: "product", reliable: true });
    expect(ownPageType("https://x.example/blog/links", audit("How to get links"))).toMatchObject({ type: "guide", reliable: true });
    expect(ownPageType("https://x.example/links", audit("How to get links"))).toMatchObject({ type: "guide", reliable: true });
    expect(ownPageType("https://x.example/tools/checker", audit("Link checker"))).toMatchObject({ type: "tool", reliable: true });
  });

  it("doesn't trust a title and address that disagree", () => {
    expect(ownPageType("https://x.example/pricing", audit("Price calculator"))).toMatchObject({ type: "tool", reliable: false, why: "its title “Price calculator” (from SEOpen's latest site audit) reads as a tool, but its address reads as a product or service page" });
  });

  it("reads the address alone when the audit has no title", () => {
    expect(ownPageType("https://x.example/blog/links", null)).toMatchObject({ type: "guide", reliable: true, why: "title or address reads as an article, from its address only, as SEOpen's latest site audit doesn't have this page's title" });
    expect(ownPageType("https://x.example/features/links", null)).toMatchObject({ type: null, reliable: false });
  });
});

describe("mismatchLine", () => {
  const mix = (types: string[]) => pageTypes(types.map((t, i) => row(t, `https://s${i}.example/x`))).mix;
  const guide = ownPageType("https://x.example/blog/links", audit("How to check your links"));

  it("says when a settled top 10 is a different kind of page", () => {
    expect(mismatchLine(mix([...Array(7).fill("Link checker"), ...Array(3).fill("How links work")]), guide)).toBe("7 of the top 10 are tools; your page is a guide or article.");
  });

  it("says nothing when Google hasn't settled, or the page is the same kind", () => {
    expect(mismatchLine(mix([...Array(5).fill("Link checker"), ...Array(5).fill("Acme links")]), guide)).toBeNull();
    expect(mismatchLine(mix(Array(10).fill("How links work")), guide)).toBeNull();
    expect(mismatchLine(mix(Array(10).fill("Link checker")), null)).toBeNull();
  });
});
