import { describe, expect, it } from "vitest";
import { makeBrand, ownBrand } from "./detect";
import { citedSources, isPlatformSite, ownershipOf, suggestCompetitors } from "./sources";

const brands = [ownBrand({ domain: "alphanote.test", name: "AlphaNote" }), makeBrand("jotwell.example", false), makeBrand("deltabarn.example", false, ["Margin"])];
const cite = (...domains: string[]) => domains.map((d) => ({ url: `https://${d}/x`, domain: d }));

describe("ownership", () => {
  it("labels yours, competitor and third party, subdomains included", () => {
    expect(ownershipOf("alphanote.test", brands)).toBe("yours");
    expect(ownershipOf("blog.alphanote.test", brands)).toBe("yours");
    expect(ownershipOf("deltabarn.example", brands)).toBe("competitor");
    expect(ownershipOf("epsilonapps.example", brands)).toBe("third_party");
  });

  it("knows the obvious platforms", () => {
    expect(isPlatformSite("en.wikipedia.org")).toBe(true);
    expect(isPlatformSite("apps.apple.com")).toBe(true);
    expect(isPlatformSite("epsilonapps.example")).toBe(false);
  });
});

describe("cited sources", () => {
  const redirect = (id: string) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${id}`;
  const answers = [
    {
      promptId: 1,
      platform: "gemini",
      mentioned: false,
      citations: [
        { url: redirect("A"), domain: "vertexaisearch.cloud.google.com", title: "epsilonapps.example" },
        { url: redirect("B"), domain: "vertexaisearch.cloud.google.com", title: "Best notes apps" },
        { url: "https://deltabarn.example/margin", domain: "deltabarn.example" },
      ],
    },
    { promptId: 2, platform: "perplexity", mentioned: false, citations: [{ url: "https://epsilonapps.example/apps", domain: "epsilonapps.example" }, { url: "https://alphanote.test/", domain: "alphanote.test" }] },
  ];

  it("counts a Gemini redirect under the site its title names, and keeps a hidden one out of the domains", () => {
    const { domains, urls } = citedSources(answers, brands);
    expect(domains.map((d) => [d.domain, d.citations, d.ownership])).toEqual([
      ["epsilonapps.example", 2, "third_party"],
      ["deltabarn.example", 1, "competitor"],
      ["alphanote.test", 1, "yours"],
    ]);
    expect(domains.some((d) => d.domain.includes("vertexaisearch"))).toBe(false);
    const hidden = urls.find((u) => u.url === redirect("B"))!;
    expect(hidden).toMatchObject({ label: "Gemini link, source hidden", ownership: null, domain: null });
    expect(urls.find((u) => u.url === redirect("A"))).toMatchObject({ label: "Gemini link to epsilonapps.example", ownership: "third_party", title: null });
  });

  it("never offers a tracked competitor or your own site for outreach", () => {
    const { domains } = citedSources(answers, brands);
    const outreach = domains.filter((d) => d.ownership === "third_party" && d.withoutUs > 0).map((d) => d.domain);
    expect(outreach).toEqual(["epsilonapps.example"]);
  });
});

describe("suggested competitors", () => {
  it("counts answers per site, skipping ours, tracked competitors and platforms", () => {
    const rows = [
      { promptId: 1, citations: cite("epsilonapps.example", "www.epsilonapps.example", "alphanote.test", "reddit.com") },
      { promptId: 1, citations: cite("blog.epsilonapps.example", "jotwell.example", "scribl.example") },
      { promptId: 2, citations: cite("scribl.example", "en.wikipedia.org") },
      { promptId: 3, citations: cite("lonely.example") },
      { promptId: 3, citations: null },
    ];
    expect(suggestCompetitors(rows, brands)).toEqual([
      { domain: "scribl.example", answers: 2, prompts: 2 },
      { domain: "epsilonapps.example", answers: 2, prompts: 1 },
    ]);
    expect(suggestCompetitors(rows, brands, { minAnswers: 1, limit: 3 }).map((s) => s.domain)).toEqual(["scribl.example", "epsilonapps.example", "lonely.example"]);
  });
});
