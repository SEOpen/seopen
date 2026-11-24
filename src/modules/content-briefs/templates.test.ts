import { describe, expect, it } from "vitest";
import { guessPageType, isOwn, optionProblems, ownerInputs, proposeOptions, resolveSubjects, subjectProblems, subjectsFromKeyword, toFill } from "./templates";
import type { BriefOption, ContentBrief } from "./types";

const own = { name: "Fernhill", domain: "fernhill.example" };
const opt = (name: string, extra: Partial<BriefOption> = {}): BriefOption => ({ name, url: null, price: null, priceCheckedOn: null, drawback: null, ...extra });
const TODAY = "2026-11-15";

describe("subjectsFromKeyword", () => {
  it("reads X and Y off keywords phrased as the template", () => {
    expect(subjectsFromKeyword("vs", "Notion vs Obsidian")).toEqual({ x: "notion", y: "obsidian" });
    expect(subjectsFromKeyword("vs", "notion versus obsidian")).toEqual({ x: "notion", y: "obsidian" });
    expect(subjectsFromKeyword("alternatives", "best mailchimp alternatives 2026")).toEqual({ x: "mailchimp", y: null });
    expect(subjectsFromKeyword("alternatives", "alternatives to mailchimp")).toEqual({ x: "mailchimp", y: null });
    expect(subjectsFromKeyword("best", "best crm for startups")).toEqual({ x: "crm", y: "startups" });
    expect(subjectsFromKeyword("pricing", "hubspot pricing")).toEqual({ x: "hubspot", y: null });
    expect(subjectsFromKeyword("guide", "how to prune roses")).toEqual({ x: null, y: null });
  });
});

describe("resolveSubjects", () => {
  it("fills a vs page from the site's name and its first tracked competitor", () => {
    expect(resolveSubjects({ pageType: "vs", keyword: "garden design software", competitors: ["fernhill.example", "rival.example"], own })).toEqual({ x: "Fernhill", y: "rival.example" });
  });

  it("prefers what was given over the keyword", () => {
    expect(resolveSubjects({ pageType: "best", keyword: "best crm for startups", x: "CRM", y: "agencies", competitors: [], own })).toEqual({ x: "CRM", y: "agencies" });
  });

  it("keeps no subjects on a guide", () => {
    expect(resolveSubjects({ pageType: "guide", keyword: "a vs b", x: "a", y: "b", competitors: [], own })).toEqual({ x: null, y: null });
  });
});

describe("subjectProblems", () => {
  it("needs two different names on a vs page", () => {
    expect(subjectProblems("vs", { x: "Fernhill", y: null })[0]).toContain("needs both names");
    expect(subjectProblems("vs", { x: "Same", y: "same" })[0]).toContain("the same");
    expect(subjectProblems("vs", { x: "A", y: "B" })).toEqual([]);
  });

  it("needs X and Y on a best-for page, and X on alternatives and pricing", () => {
    expect(subjectProblems("best", { x: "crm", y: null })).toHaveLength(1);
    expect(subjectProblems("alternatives", { x: null, y: null })).toHaveLength(1);
    expect(subjectProblems("pricing", { x: null, y: null })).toHaveLength(1);
    expect(subjectProblems("guide", { x: null, y: null })).toEqual([]);
  });
});

describe("isOwn", () => {
  it("knows the site by name, domain, subdomain or URL", () => {
    expect(isOwn("Fernhill", own)).toBe(true);
    expect(isOwn("www.fernhill.example", own)).toBe(true);
    expect(isOwn("Something", own, "https://shop.fernhill.example/x")).toBe(true);
    expect(isOwn("notfernhill.example", own)).toBe(false);
  });
});

describe("proposeOptions", () => {
  it("lists competitors, then top 10 sites, never the site itself or review sites, at most 8", () => {
    const options = proposeOptions("alternatives", { x: "mailchimp", y: null }, ["a.example", "fernhill.example"], ["www.reddit.com", "mailchimp.com", "b.example", "a.example", "c.example", "d.example", "e.example", "f.example", "g.example", "h.example"], own);
    expect(options.map((o) => o.name)).toEqual(["a.example", "b.example", "c.example", "d.example", "e.example", "f.example", "g.example", "h.example"]);
    expect(options.every((o) => o.price === null && o.drawback === null)).toBe(true);
  });

  it("gives a vs page its two sides", () => {
    expect(proposeOptions("vs", { x: "Fernhill", y: "rival.example" }, [], [], own).map((o) => o.name)).toEqual(["Fernhill", "rival.example"]);
  });

  it("gives a guide no options", () => {
    expect(proposeOptions("guide", { x: null, y: null }, ["a.example"], [], own)).toEqual([]);
  });
});

describe("optionProblems", () => {
  const five = ["a", "b", "c", "d", "e"].map((n) => opt(n));

  it("holds an alternatives page to 5 to 8 options", () => {
    expect(optionProblems("alternatives", five.slice(0, 4), own, TODAY)[0]).toContain("5 to 8");
    expect(optionProblems("alternatives", [...five, ...five.map((o) => opt(`${o.name}2`))], own, TODAY)[0]).toContain("this has 10");
    expect(optionProblems("alternatives", five, own, TODAY)).toEqual([]);
  });

  it("never lets the site rank itself first", () => {
    expect(optionProblems("alternatives", [opt("Fernhill"), ...five.slice(1)], own, TODAY)).toEqual(["Don't rank your own site first. Move it down the list."]);
    expect(optionProblems("best", [opt("x", { url: "https://fernhill.example/" })], own, TODAY)).toHaveLength(1);
    expect(optionProblems("alternatives", [...five.slice(0, 4), opt("Fernhill")], own, TODAY)).toEqual([]);
  });

  it("needs a real checked-on date, not in the future, for every price", () => {
    expect(optionProblems("vs", [opt("A", { price: "$10/mo" })], own, TODAY)[0]).toContain("no checked-on date");
    expect(optionProblems("vs", [opt("A", { price: "$10/mo", priceCheckedOn: "last week" })], own, TODAY)[0]).toContain("should be a date");
    expect(optionProblems("vs", [opt("A", { price: "$10/mo", priceCheckedOn: "2026-12-01" })], own, TODAY)[0]).toContain("in the future");
    expect(optionProblems("vs", [opt("A", { price: "$10/mo", priceCheckedOn: TODAY })], own, TODAY)).toEqual([]);
  });

  it("refuses the same option twice", () => {
    expect(optionProblems("vs", [opt("A"), opt("a")], own, TODAY)[0]).toContain("listed twice");
  });
});

describe("ownerInputs", () => {
  it("asks for 3 to 5 things only the owner has, prices on commercial pages", () => {
    for (const t of ["guide", "vs", "alternatives", "best", "pricing"] as const) {
      const inputs = ownerInputs(t, { x: "X", y: null });
      expect(inputs.length).toBeGreaterThanOrEqual(3);
      expect(inputs.length).toBeLessThanOrEqual(5);
      expect(inputs.some((i) => i.id === "drawback")).toBe(true);
      expect(inputs.some((i) => i.id === "prices")).toBe(t !== "guide");
    }
  });
});

describe("toFill", () => {
  const brief = {
    template: { pageType: "alternatives", x: "mailchimp", y: null },
    ownerInputs: ownerInputs("alternatives", { x: "mailchimp", y: null }),
    options: [opt("a"), opt("b")],
  } as unknown as ContentBrief;

  it("lists the angle, every owner input, missing options and each drawback", () => {
    const missing = toFill(brief, {});
    expect(missing[0]).toBe("The angle the top 3 all miss");
    expect(missing).toContain("3 more options (5 to 8)");
    expect(missing).toContain("A real drawback of a");
    expect(missing).toHaveLength(1 + 5 + 1 + 2);
  });

  it("is empty once everything is written", () => {
    const options = ["a", "b", "c", "d", "e"].map((n) => opt(n, { drawback: "Slow support" }));
    const inputs = Object.fromEntries(brief.ownerInputs.map((i) => [i.id, "Ours"]));
    expect(toFill(brief, { angle: "Nobody tests deliverability", inputs, options })).toEqual([]);
  });
});

describe("guessPageType", () => {
  it("reads the page type off the keyword, a guide otherwise", () => {
    expect(guessPageType("notion vs obsidian")).toBe("vs");
    expect(guessPageType("mailchimp alternatives")).toBe("alternatives");
    expect(guessPageType("best crm for startups")).toBe("best");
    expect(guessPageType("hubspot pricing")).toBe("pricing");
    expect(guessPageType("how to prune roses")).toBe("guide");
  });
});
