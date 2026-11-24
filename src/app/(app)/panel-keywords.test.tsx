import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PanelKeyword, PanelKeywords } from "./dashboard-panel";
import { PanelKeywordsTable } from "./panel-keywords";

const row = (key: string, over: Partial<PanelKeyword> = {}): PanelKeyword => ({ key, keyword: key, href: "/rank", position: 4, previous: null, status: null, delta: null, clicks: 0, ctr: 0, url: null, ...over });

const table = (rows: PanelKeyword[]) => {
  const data: PanelKeywords = { source: "rank", title: "Keywords", href: "/rank", window: "7d", total: rows.length, rows };
  return renderToStaticMarkup(<PanelKeywordsTable data={data} />);
};

describe("PanelKeywordsTable", () => {
  it("hides a column that's zero in every row", () => {
    const html = table([row("a"), row("b")]);
    expect(html).not.toContain(">Clicks<");
    expect(html).not.toContain(">CTR<");
  });

  it("hides a column with nothing in any row", () => {
    const html = table([row("a", { clicks: null, ctr: null })]);
    expect(html).not.toContain(">Clicks<");
    expect(html).not.toContain(">CTR<");
  });

  it("marks a position no look confirmed, with the same words as Rankings", () => {
    const html = table([row("seo salem", { position: 1, notConfirmed: true }), row("b")]);
    expect(html.match(/not confirmed/g)).toHaveLength(1);
    expect(html).toContain("so this is its last known position.");
    expect(table([row("a"), row("b")])).not.toContain("not confirmed");
  });

  it("shows a column when any row has something, with the others' zeros", () => {
    const html = table([row("a", { clicks: 3, ctr: 0.02 }), row("b")]);
    expect(html).toContain(">Clicks<");
    expect(html).toContain(">CTR<");
  });
});
