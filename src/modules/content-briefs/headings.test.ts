import { describe, expect, it } from "vitest";
import { headingDepths, nestOutline, pageHeadings, plainLine, sharedHeadings } from "./headings";

describe("pageHeadings", () => {
  it("reads H1 to H3 in order, as plain text, leaving out nav, footer and scripts", () => {
    const html = `<html><body>
      <nav><h2>Menu</h2></nav>
      <h1>How to <em>prune</em> roses</h1>
      <!-- <h2>Hidden</h2> -->
      <script>document.write("<h2>Script</h2>")</script>
      <h2 class="x">When &amp; why</h2>
      <h3>Tools</h3>
      <h4>Too deep</h4>
      <footer><h2>Footer</h2></footer>
    </body></html>`;
    expect(pageHeadings(html)).toEqual([
      { level: 1, text: "How to prune roses" },
      { level: 2, text: "When & why" },
      { level: 3, text: "Tools" },
    ]);
  });

  it("leaves out comment-form and sidebar headings (QA B12)", () => {
    const html = `<body><h1>Free backlink checker</h1><h2>How it works</h2><div id="respond"><h3>Leave a Reply <small><a href="#">Cancel reply</a></small></h3></div><div class="widget"><h2>Related Posts</h2></div></body>`;
    expect(pageHeadings(html).map((h) => h.text)).toEqual(["Free backlink checker", "How it works"]);
  });

  it("keeps at most 25", () => {
    expect(pageHeadings("<h2>x</h2>".repeat(40))).toHaveLength(25);
  });
});

describe("plainLine", () => {
  it("folds whitespace, drops control characters and cuts long text", () => {
    expect(plainLine("  a\n\tb\u0007 c ")).toBe("a b c");
    expect(plainLine("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("sharedHeadings", () => {
  it("keeps headings at least 2 pages share, ignoring numbering, case and punctuation", () => {
    const shared = sharedHeadings([
      [{ level: 1, text: "Guide" }, { level: 2, text: "1. When to prune" }, { level: 2, text: "Tools you need" }, { level: 2, text: "Related posts" }],
      [{ level: 2, text: "When to prune?" }, { level: 3, text: "Tools you need" }, { level: 2, text: "Related posts" }],
      [{ level: 2, text: "when to prune" }, { level: 2, text: "Something else" }],
    ]);
    expect(shared).toEqual([
      { text: "1. When to prune", pages: 3 },
      { text: "Tools you need", pages: 2 },
    ]);
  });
});

describe("headingDepths", () => {
  it("puts each heading one step inside the nearest higher heading, never skipping a step", () => {
    // H1, then H3s with no H2, then a proper H2 and H3: the H3s under the H1 sit one step in, like the H2.
    expect(
      headingDepths([
        { level: 1, text: "Free backlink checker" },
        { level: 3, text: "Paste a domain" },
        { level: 3, text: "Read the report" },
        { level: 2, text: "Why backlinks matter" },
        { level: 3, text: "Quality over count" },
      ]),
    ).toEqual([0, 1, 1, 1, 2]);
  });

  it("starts at 0 when a page opens below H1", () => {
    expect(headingDepths([{ level: 3, text: "Step one" }, { level: 3, text: "Step two" }, { level: 2, text: "Wrap-up" }, { level: 3, text: "Next" }])).toEqual([0, 0, 0, 1]);
    expect(headingDepths([])).toEqual([]);
  });
});

describe("nestOutline", () => {
  it("makes an H3 with no H2 before it an H2 and leaves the rest alone", () => {
    const from = "Page type";
    expect(
      nestOutline([
        { level: 3, text: "Orphan", from },
        { level: 2, text: "Section", from },
        { level: 3, text: "Child", from },
      ]).map((h) => [h.level, h.text]),
    ).toEqual([
      [2, "Orphan"],
      [2, "Section"],
      [3, "Child"],
    ]);
  });
});
