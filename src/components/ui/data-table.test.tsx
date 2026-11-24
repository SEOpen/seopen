import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DataTable, isCount, isWordy, toCsv } from "./data-table";

const rows = [
  { keyword: "seo", volume: 1200, plan: "Internal", present: "5 of 9" },
  { keyword: "rank", volume: 40, plan: "No limit", present: "12" },
];
const columns = [
  { key: "keyword", label: "Keyword" },
  { key: "volume", label: "Volume", format: "number" as const },
  { key: "plan", label: "Plan", align: "right" as const },
  { key: "present", label: "Points", align: "right" as const },
];

/** The part of a header from its opening tag up to the one that closes it. */
const header = (html: string, label: string) => html.slice(html.lastIndexOf("<th", html.indexOf(`>${label}<`)), html.indexOf("</th>", html.indexOf(`>${label}<`)));
const cells = (html: string) => [...html.matchAll(/<td class="([^"]*)">/g)].map((m) => m[1]);

describe("sort carets", () => {
  it("keep a right-aligned label on the column's edge, with the caret out of the flow to its left", () => {
    const th = header(renderToStaticMarkup(<DataTable columns={columns} rows={rows} initialSort={{ key: "volume", desc: true }} />), "Volume");
    expect(th).toContain("text-right");
    expect(th).toContain("absolute");
    expect(th).toContain("right-full");
    expect(th).not.toContain("gap-1");
  });

  it("sit after a left-aligned label", () => {
    const th = header(renderToStaticMarkup(<DataTable columns={columns} rows={rows} initialSort={{ key: "keyword" }} />), "Keyword");
    expect(th).toContain("left-full");
  });

  it("reserve no room when a column isn't sorted", () => {
    const th = header(renderToStaticMarkup(<DataTable columns={columns} rows={rows} />), "Volume");
    expect(th).not.toContain("<svg");
    expect(th).not.toContain("absolute");
  });
});

describe("mono", () => {
  it("gives the row count's digits the data size, staying in Outfit with its word", () => {
    const html = renderToStaticMarkup(<DataTable columns={columns} rows={rows} />);
    expect(html).toContain('<span class="digits">2</span>');
    expect(html).toMatch(/font-sans[^>]*> rows</);
    expect(html).not.toContain("data ml-auto");
  });

  it("keeps right-aligned numbers in mono and takes it off words", () => {
    const [, volume, plan, present] = cells(renderToStaticMarkup(<DataTable columns={columns} rows={rows} />));
    expect(volume).toContain("data");
    expect(plan).not.toContain("data");
    expect(plan).toContain("text-right");
    expect(present).not.toContain("data");
  });

  it("marks the digits inside a right-aligned mix of words and numbers", () => {
    expect(renderToStaticMarkup(<DataTable columns={columns} rows={rows} />)).toContain('<span class="data">9</span>');
  });

  it.each(["Top 10 SEO tools", "3d printers", "Top 20 + AI Overviews", "10 best tools", "Nov 3, 2026"])("leaves free text whole: %s", (text) => {
    const html = renderToStaticMarkup(<DataTable columns={[{ key: "anchor", label: "Link text" }]} rows={[{ anchor: text }]} />);
    expect(html).toContain(`>${text}</td>`);
  });

  it("marks the digits of a count in a left-aligned column", () => {
    const html = renderToStaticMarkup(<DataTable columns={[{ key: "found", label: "Found" }]} rows={[{ found: "5/9 · 2 failed" }]} />);
    expect(html).toContain('<span class="data">5</span>');
    expect(html).toContain('<span class="data">9</span>');
    expect(html).toMatch(/font-sans[^>]*> failed</);
  });

  it("tells a count from free text by the whole value", () => {
    for (const count of [12, "12", "1,204", "$1.20", "12.3%", "+12", "5 of 9", "5/9", "5/9 · 2 failed", "12 of 30 (2 failed)", "12 of 30 (2 failed), 3 rechecked, 1 not checked"]) expect(isCount(count)).toBe(true);
    for (const text of ["Top 10 SEO tools", "3d printers", "3d", "4K", "10 best tools", "5 of 9 stars", "Internal", "", null]) expect(isCount(text)).toBe(false);
  });

  it("tells words from numbers by the value", () => {
    expect(isWordy("Internal")).toBe(true);
    expect(isWordy("5 of 9")).toBe(true);
    expect(isWordy("1,204")).toBe(false);
    expect(isWordy("–")).toBe(false);
    expect(isWordy(12)).toBe(false);
    expect(isWordy(null)).toBe(false);
  });
});

describe("CSV download", () => {
  it("writes a page title that starts with a formula character as text, and keeps real numbers numeric", () => {
    const csv = toCsv(
      [
        { title: "=SUM(1,2)", delta: -3.5, note: "-12" },
        { title: "Plain title", delta: 4, note: "@cmd" },
      ],
      [
        { key: "title", label: "Title" },
        { key: "delta", label: "Change" },
        { key: "note", label: "Note" },
      ],
      "UTC",
    );
    expect(csv.split("\n")).toEqual(["Title,Change,Note", `"'=SUM(1,2)",-3.5,-12`, "Plain title,4,'@cmd"]);
  });
});
