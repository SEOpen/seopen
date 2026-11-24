import { describe, expect, it } from "vitest";
import { buildBrief } from "./build";
import { buildInput } from "./fixtures";
import { exportMarkdown, md } from "./markdown";
import type { BriefView } from "./types";

const day = (iso: string) => iso.slice(0, 10);
const view = (over: Partial<BriefView> = {}): BriefView => {
  const brief = buildBrief(buildInput());
  return { id: 1, keyword: "prune roses", pageType: "guide", brief, fill: {}, creditsSpent: 4, createdAt: new Date(brief.createdAt), updatedAt: new Date(brief.createdAt), ...over };
};

describe("md", () => {
  it("keeps text from the web on one line with Markdown's characters escaped", () => {
    expect(md("# Big *deal*\n[link](x) <b>")).toBe("\\# Big \\*deal\\* \\[link\\](x) \\<b\\>");
  });
});

describe("exportMarkdown", () => {
  it("has every section with sources and dates, and marks what's to fill", () => {
    const out = exportMarkdown(view(), day);
    for (const h of ["## 1. Target", "## 2. What ranks", "## 3. AI Overview", "## 4. Questions to answer", "## 5. What the top 3 cover", "## 6. Outline", "## 7. Only you can add these", "## 8. Internal links", "## Still to fill"]) expect(out).toContain(h);
    expect(out).toContain("Volume 2,400 a month, difficulty 31, intent informational. Source: Keyword overview, DataForSEO Labs, 2026-11-10.");
    expect(out).toContain("**Warning:** Only 3 of 5 results share a page type");
    expect(out).toContain("Google shows an AI Overview. It cites 1 page:");
    expect(out).toContain("**The angle they all miss** (to fill):");
    expect(out).toContain("- [ ] Your own numbers: a figure");
    expect(out).toContain("  To fill.");
    expect(out).toContain("Only the title is known: Google hides this result's address");
    expect(out).toContain("- H2: When to prune _(2 of the top 3 pages)_");
    expect(out).toContain("This is a brief, not an article.");
  });

  it("shows the owner's answers and leaves no to-fill list once complete", () => {
    const v = view();
    const inputs = Object.fromEntries(v.brief.ownerInputs.map((i) => [i.id, "Our *own* figure"]));
    const out = exportMarkdown({ ...v, fill: { angle: "Nobody says when not to prune", inputs } }, day);
    expect(out).toContain("Nobody says when not to prune");
    expect(out).toContain("- [x] Your own numbers");
    expect(out).toContain("Our \\*own\\* figure");
    expect(out).toContain("Nothing left to fill");
    expect(out).not.toContain("## Still to fill");
  });

  it("lists options with their price dates on an alternatives page", () => {
    const brief = buildBrief(buildInput({ pageType: "alternatives", subjects: { x: "mailchimp", y: null } }));
    const options = [{ name: "a.example", url: "https://a.example/", price: "$10/mo", priceCheckedOn: "2026-11-01", drawback: null }];
    const out = exportMarkdown(view({ pageType: "alternatives", brief, fill: { options } }), day);
    expect(out).toContain("## Options");
    expect(out).toContain("   - Price: $10/mo, checked on 2026-11-01");
    expect(out).toContain("   - Drawback: To fill");
    expect(out).toContain("- H2: 1. a.example _(Page type)_");
    expect(out).toContain("- [ ] 4 more options (5 to 8)");
  });

  it("nests a top page's headings one step at a time when it skips a level, keeping the page's own levels", () => {
    const brief = buildBrief(buildInput());
    const skipped = { ...brief.top3.pages[0], headings: [{ level: 1 as const, text: "Prune roses" }, { level: 3 as const, text: "Pick sharp shears" }, { level: 2 as const, text: "When to prune" }, { level: 3 as const, text: "In spring" }] };
    const out = exportMarkdown(view({ brief: { ...brief, top3: { ...brief.top3, pages: [skipped] } } }), day);
    expect(out).toContain(["- H1: Prune roses", "  - H3: Pick sharp shears", "  - H2: When to prune", "    - H3: In spring"].join("\n"));
  });
});
