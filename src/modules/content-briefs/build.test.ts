import { describe, expect, it } from "vitest";
import { aiOverview, buildBrief, paaQuestions, serpEntries } from "./build";
import { buildInput, SERP } from "./fixtures";

describe("serpEntries", () => {
  it("keeps the organic and video results with a page type and why, marking the site's own", () => {
    const rows = serpEntries(SERP, "fernhill.example");
    expect(rows.map((r) => [r.position, r.domain, r.type, r.isProject])).toEqual([
      [1, "rhs.example", "guide", false],
      [2, "garden.example", "guide", false],
      [3, "fernhill.example", null, true],
      [4, "youtube.com", "video", false],
      [5, "tips.example", "guide", false],
    ]);
  });
});

describe("paaQuestions and aiOverview", () => {
  it("reads People also ask and the AI Overview's cited pages once each", () => {
    expect(paaQuestions(SERP)).toEqual(["When should roses be pruned?", "How far back do you cut roses?"]);
    expect(aiOverview(SERP)).toEqual({ present: true, cited: [{ domain: "rhs.example", url: "https://www.rhs.example/prune", title: "Pruning roses" }] });
    expect(aiOverview(null)).toEqual({ present: false, cited: [] });
  });
});

describe("buildBrief", () => {
  const brief = buildBrief(buildInput());

  it("gives every figure its source and date", () => {
    expect(brief.target).toMatchObject({ keyword: "prune roses", volume: 2400, kd: 31, intent: "informational", source: { label: "Keyword overview, DataForSEO Labs", at: "2026-11-10T10:00:00.000Z" } });
    expect(brief.target.merged).toEqual([{ keyword: "pruning roses", volume: 900, kd: 28, intent: "informational" }]);
    expect(brief.serp.source?.at).toBe("2026-11-10T10:00:00.000Z");
    expect(brief.questions.keywordsSource?.label).toBe("Question keywords, DataForSEO Labs");
  });

  it("says which page type leads, with a warning when under 6 of 10 agree", () => {
    expect(brief.serp).toMatchObject({ dominant: "guide", agree: 3, total: 5 });
    expect(brief.serp.warning).toContain("Only 3 of 5");
    expect(brief.serp.byType[0]).toEqual({ type: "guide", urls: ["https://www.rhs.example/prune", "https://garden.example/blog/roses", "https://tips.example/guide"] });
  });

  it("leaves the main keyword out of the question keywords", () => {
    expect(brief.questions.keywords.map((k) => k.keyword)).toEqual(["when to prune roses", "how to prune roses"]);
  });

  it("outlines headings only, each with where it came from", () => {
    expect(brief.outline.map((h) => [h.level, h.text, h.from])).toEqual([
      [2, "When to prune", "2 of the top 3 pages"],
      [2, "What we found when we tried it", "Page type"],
      [2, "Mistakes to avoid", "Page type"],
      [2, "Limits and drawbacks", "Page type"],
      [2, "Questions people ask", "People also ask and question keywords"],
      [3, "When should roses be pruned?", "People also ask"],
      [3, "How far back do you cut roses?", "People also ask"],
      [3, "When to prune roses?", "Question keywords"],
      [3, "How to prune roses?", "Question keywords"],
    ]);
  });

  it("joins shared competitor headings as H2s, whatever level the pages used, and skips ones the template has", () => {
    const page = (position: number, headings: { level: 1 | 2 | 3; text: string }[]) => ({ position, url: `https://p${position}.example/`, domain: `p${position}.example`, title: null, read: "read" as const, why: null, headings });
    const outline = buildBrief(
      buildInput({
        serp: { value: { ...SERP, items: [] }, at: null, aioLoaded: true },
        questions: { value: [], at: null },
        top3: {
          value: [
            page(1, [{ level: 1, text: "Prune roses" }, { level: 3, text: "Pick sharp shears" }, { level: 2, text: "Mistakes to avoid" }]),
            page(2, [{ level: 3, text: "Pick sharp shears" }, { level: 3, text: "Mistakes to avoid" }]),
          ],
          at: null,
        },
      }),
    ).outline;
    expect(outline.map((h) => [h.level, h.text, h.from])).toEqual([
      [2, "Pick sharp shears", "2 of the top 3 pages"],
      [2, "What we found when we tried it", "Page type"],
      [2, "Mistakes to avoid", "Page type"],
      [2, "Limits and drawbacks", "Page type"],
    ]);
  });

  it("asks for the owner-only inputs and notes a missed AI Overview when the lookup didn't load one", () => {
    expect(brief.ownerInputs.map((i) => i.id)).toEqual(["numbers", "test", "screenshots", "drawback"]);
    const plain = buildBrief(buildInput({ serp: { value: { ...SERP, items: SERP.items!.slice(1) }, at: null, aioLoaded: false } }));
    expect(plain.aiOverview).toMatchObject({ present: false, loaded: false, cited: [] });
  });
});
