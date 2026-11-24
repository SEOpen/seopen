import { describe, expect, it } from "vitest";
import { rules } from "@/plan-policy/rules";
import { leadSentence, splitLead, teardownMarkdown } from "./teardown-text";

describe("splitLead", () => {
  it("takes the first sentence and keeps the rest", () => {
    expect(splitLead("It wins on templates. Each city gets a page.\n\nSecond paragraph.")).toEqual({ lead: "It wins on templates.", rest: "Each city gets a page.\n\nSecond paragraph." });
  });

  it("doesn't end a sentence inside a domain", () => {
    expect(splitLead("rival-two.example gets most clicks from its blog. More here.").lead).toBe("rival-two.example gets most clicks from its blog.");
  });

  it("stops at the first line when it has no full stop", () => {
    expect(splitLead("No full stop here\nNext line.")).toEqual({ lead: "No full stop here", rest: "Next line." });
  });
});

describe("leadSentence", () => {
  it("cuts a long sentence with an ellipsis", () => {
    const s = leadSentence(`${"a".repeat(300)}.`, 20);
    expect(s).toHaveLength(20);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("teardownMarkdown", () => {
  it("writes moves before findings, with sizes in words", () => {
    const md = teardownMarkdown(
      { domain: "example.com", summary: "It wins.", findings: [{ title: "Blog", body: "Most clicks." }], moves: [{ title: "Add a glossary", why: "Cheap links.", size: "project", firstStep: "List 20 terms." }], creditsSpent: 1, savedBy: null },
      { projectName: "Fernhill", market: "United States", savedOn: "Nov 16, 2026" },
    );
    expect(md).toContain(rules.hasPlans ? "1 research credit spent" : "$0.01 spent");
    expect(md).toContain("Size: A larger build");
    expect(md.indexOf("## Moves for your site")).toBeLessThan(md.indexOf("## What example.com does"));
  });
});
